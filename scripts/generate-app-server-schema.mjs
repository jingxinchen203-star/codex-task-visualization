import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand } from "../src/process/run-command.js";
import { validateExecutionEvidence } from "../src/process/execution-evidence.js";
import {
  OperationGuard,
  assertContained,
  classifyExecutionPath,
  codedError,
  createOwnedDirectory,
  ensureLocalDirectory,
  identityOf,
  safeRemoveOwnedDirectory,
  sameIdentity,
  validateLocalPath,
  verifyOwnedDirectory,
} from "../src/process/security-policy.js";
import { extractThreadSourceKinds } from "../src/app-server/schema-contract.js";

async function requireAbsent(path, guard) {
  guard.check();
  try {
    await guard.race(lstat(path));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw codedError("EEXIST", `Refusing to replace existing schema destination: ${path}`);
}

function requireSuccess(result, operation) {
  if (result.error) {
    const error = codedError(result.error.code ?? "ECOMMAND", result.error.message);
    error.unsettled = result.unsettled === true;
    error.processOutcome = result;
    throw error;
  }
  validateExecutionEvidence(result, operation);
  if (result.stdoutTruncated || result.stderrTruncated) throw codedError("EOUTPUTTRUNCATED", `${operation} output was truncated`);
  if (result.code !== 0) throw codedError("ECOMMAND", result.stderr?.trim() || `${operation} failed`);
  return result;
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonLossless(source) {
  let index = 0;
  const skipWhitespace = () => {
    while (index < source.length && /[ \t\r\n]/u.test(source[index])) index += 1;
  };
  const expect = (character) => {
    skipWhitespace();
    if (source[index] !== character) throw codedError("EINVALIDSCHEMAJSON", `Expected ${character} at JSON offset ${index}`);
    index += 1;
  };
  const stringToken = () => {
    skipWhitespace();
    if (source[index] !== '"') throw codedError("EINVALIDSCHEMAJSON", `Expected string at JSON offset ${index}`);
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      index += 1;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        const raw = source.slice(start, index);
        return { decoded: JSON.parse(raw), canonical: JSON.stringify(JSON.parse(raw)) };
      }
    }
    throw codedError("EINVALIDSCHEMAJSON", `Unterminated string at JSON offset ${start}`);
  };
  const parseValue = () => {
    skipWhitespace();
    const character = source[index];
    if (character === '"') return stringToken().canonical;
    if (character === "[") {
      index += 1;
      const values = [];
      skipWhitespace();
      if (source[index] !== "]") {
        while (true) {
          values.push(parseValue());
          skipWhitespace();
          if (source[index] !== ",") break;
          index += 1;
        }
      }
      expect("]");
      return `[${values.join(",")}]`;
    }
    if (character === "{") {
      index += 1;
      const entries = [];
      skipWhitespace();
      if (source[index] !== "}") {
        while (true) {
          const key = stringToken();
          expect(":");
          entries.push({ key: key.decoded, canonicalKey: key.canonical, value: parseValue(), order: entries.length });
          skipWhitespace();
          if (source[index] !== ",") break;
          index += 1;
        }
      }
      expect("}");
      entries.sort((left, right) => ordinalCompare(left.key, right.key) || left.order - right.order);
      return `{${entries.map(({ canonicalKey, value }) => `${canonicalKey}:${value}`).join(",")}}`;
    }
    const remainder = source.slice(index);
    const literal = remainder.match(/^(?:true|false|null)/u)?.[0];
    if (literal) {
      index += literal.length;
      return literal;
    }
    const number = remainder.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
    if (number) {
      index += number.length;
      return number;
    }
    throw codedError("EINVALIDSCHEMAJSON", `Invalid JSON value at offset ${index}`);
  };
  const canonical = parseValue();
  skipWhitespace();
  if (index !== source.length) throw codedError("EINVALIDSCHEMAJSON", `Trailing JSON content at offset ${index}`);
  return canonical;
}

function remainingTimeout(deadlineAt) {
  return Math.max(1, deadlineAt - Date.now());
}

const MAX_SCHEMA_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SCHEMA_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SCHEMA_FILES = 512;
const MAX_SCHEMA_DEPTH = 32;

async function rawFileEvidence(root, path, guard, budget) {
  guard.check();
  const file = await validateLocalPath(path, { guard, kind: "file" });
  assertContained(root, file.canonicalPath);
  const before = identityOf(await guard.race(stat(file.canonicalPath, { bigint: true })));
  const rawHash = createHash("sha256");
  const chunks = [];
  let byteCount = 0;
  const stream = createReadStream(file.canonicalPath, { signal: guard.signal });
  try {
    for await (const chunk of stream) {
      guard.check();
      byteCount += chunk.length;
      if (byteCount > MAX_SCHEMA_FILE_BYTES) {
        throw codedError("ESCHEMAFILETOOLARGE", `Generated schema file exceeds ${MAX_SCHEMA_FILE_BYTES} bytes: ${path}`);
      }
      budget.bytes += chunk.length;
      if (budget.bytes > MAX_SCHEMA_TOTAL_BYTES) {
        throw codedError("ESCHEMATOTALTOOLARGE", `Generated schema set exceeds ${MAX_SCHEMA_TOTAL_BYTES} bytes`);
      }
      rawHash.update(chunk);
      chunks.push(chunk);
    }
  } catch (error) {
    throw guard.kind ? guard.error() : error;
  }
  guard.check();
  const after = identityOf(await guard.race(stat(file.canonicalPath, { bigint: true })));
  if (!sameIdentity(before, after)) throw codedError("EIDENTITYCHANGED", `Generated schema file changed while hashing: ${path}`);
  const source = Buffer.concat(chunks, byteCount).toString("utf8");
  const sha256 = rawHash.digest("hex");
  const semanticSha256 = createHash("sha256")
    .update(canonicalJsonLossless(source))
    .digest("hex");
  guard.check();
  return { sha256, semanticSha256, bytes: byteCount, source };
}

async function schemaFiles(owned, guard) {
  const files = [];
  const pending = [{ path: owned.canonicalPath, depth: 0 }];
  while (pending.length > 0) {
    guard.check();
    await verifyOwnedDirectory(owned, guard);
    const current = pending.pop();
    const directory = await validateLocalPath(current.path, { guard, kind: "directory" });
    if (current.depth > 0) assertContained(owned.canonicalPath, directory.canonicalPath);
    const entries = await guard.race(readdir(directory.canonicalPath, { withFileTypes: true }));
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isSymbolicLink()) throw codedError("EREPARSEPATH", `Generated schema contains a reparse point: ${path}`);
      if (entry.isDirectory()) {
        if (current.depth >= MAX_SCHEMA_DEPTH) {
          throw codedError("ESCHEMADEPTH", `Generated schema nesting exceeds ${MAX_SCHEMA_DEPTH}: ${path}`);
        }
        pending.push({ path, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        files.push(path);
        if (files.length > MAX_SCHEMA_FILES) {
          throw codedError("ESCHEMAFILECOUNT", `Generated schema set exceeds ${MAX_SCHEMA_FILES} files`);
        }
      } else {
        throw codedError("EUNSUPPORTEDSCHEMAFILE", `Unsupported generated schema entry: ${path}`);
      }
    }
  }
  return files;
}

async function digestSchemaSet(owned, guard) {
  const root = owned.canonicalPath;
  const paths = (await schemaFiles(owned, guard)).sort((left, right) =>
    ordinalCompare(relative(root, left).split(sep).join("/"), relative(root, right).split(sep).join("/")),
  );
  const rawDigest = createHash("sha256");
  const semanticDigest = createHash("sha256");
  const files = [];
  const budget = { bytes: 0 };
  let sourceKinds = null;
  for (const path of paths) {
    const relativePath = relative(root, path).split(sep).join("/");
    await verifyOwnedDirectory(owned, guard);
    const evidence = await rawFileEvidence(root, path, guard, budget);
    const { source, ...publicEvidence } = evidence;
    files.push({ path: relativePath, ...publicEvidence });
    if (relativePath === "v2/ThreadListParams.json") {
      try {
        sourceKinds = extractThreadSourceKinds(JSON.parse(source));
      } catch (error) {
        throw codedError("EINVALIDSCHEMAJSON", `Invalid thread source-kind schema: ${error.message}`);
      }
    }
    rawDigest.update(`${relativePath}\0${evidence.sha256}\0${evidence.bytes}\n`);
    semanticDigest.update(`${relativePath}\0${evidence.semanticSha256}\n`);
  }
  if (!sourceKinds) throw codedError("EINVALIDSCHEMAJSON", "Generated schema set is missing v2/ThreadListParams.json");
  return {
    schemaSet: { rawSha256: rawDigest.digest("hex"), semanticSha256: semanticDigest.digest("hex"), files },
    sourceKinds,
  };
}

function executionHash(execution) {
  const wrapper = execution.files.find(({ role }) => role === "wrapper");
  const native = execution.files.find(({ role }) => role === "native");
  return (wrapper ?? native)?.sha256 ?? null;
}

function retainedSchemaCleanup(deferred, message = "Temporary schema root retained because the generator child is unsettled") {
  return {
    attempted: false,
    deferred,
    retained: true,
    ok: false,
    error: { name: "Error", code: "ECHILDUNSETTLED", message },
  };
}

function scheduleSchemaCleanup(owned, settlement) {
  return Promise.resolve(settlement).then(async (outcome) => {
    if (outcome?.unsettled !== false) {
      return Object.freeze({ settlement: outcome, cleanup: retainedSchemaCleanup(false) });
    }
    const cleanup = await safeRemoveOwnedDirectory(owned);
    return Object.freeze({ settlement: outcome, cleanup });
  }, (error) => Object.freeze({
    settlement: { unsettled: true, error: { name: error.name ?? "Error", code: error.code ?? null, message: error.message ?? String(error) } },
    cleanup: retainedSchemaCleanup(false, "Temporary schema root retained because child settlement failed"),
  }));
}

export async function generateAppServerSchema(binary, output, { run = runCommand, timeoutMs = 120_000, signal = null } = {}) {
  if (!binary || !output) throw codedError("EUSAGE", "binary and output are required");
  const deadlineAt = Date.now() + timeoutMs;
  const guard = new OperationGuard({ timeoutMs, signal });
  let temporaryOwned = null;
  let published = false;

  try {
    guard.check();
    classifyExecutionPath(output);
    const lexicalDestination = resolve(output);
    classifyExecutionPath(lexicalDestination);
    const parent = await ensureLocalDirectory(dirname(lexicalDestination), guard);
    const destination = join(parent.canonicalPath, basename(lexicalDestination));
    await requireAbsent(destination, guard);
    temporaryOwned = await createOwnedDirectory(parent.canonicalPath, `.${basename(destination)}.tmp-`, guard);
    const temporary = temporaryOwned.canonicalPath;

    const versionResult = requireSuccess(await run(binary, ["--version"], { deadlineAt, timeoutMs: remainingTimeout(deadlineAt), signal }), "version");
    const version = versionResult.stdout.trim();
    if (!version) throw codedError("EEMPTYVERSION", "Version command returned an empty version");
    if (!versionResult.execution?.digest || !Array.isArray(versionResult.execution.files)) {
      throw codedError("EIDENTITYMISSING", "Version command did not report execution identity");
    }

    const schemaResult = requireSuccess(
      await run(binary, ["app-server", "generate-json-schema", "--out", temporary], { deadlineAt, timeoutMs: remainingTimeout(deadlineAt), signal }),
      "schema generation",
    );
    if (schemaResult.execution?.digest !== versionResult.execution.digest) {
      throw codedError("EIDENTITYCHANGED", "Execution identity changed between version and schema generation");
    }
    if (schemaResult.executionContext?.contextDigest !== versionResult.executionContext?.contextDigest) {
      throw codedError("EIDENTITYCHANGED", "Execution context changed between version and schema generation");
    }

    await verifyOwnedDirectory(temporaryOwned, guard);
    const { schemaSet, sourceKinds } = await digestSchemaSet(temporaryOwned, guard);
    guard.check();
    const execution = versionResult.execution;
    const launcherSha256 = executionHash(execution);
    const nativeSha256 = execution.files.find(({ role }) => role === "native")?.sha256 ?? null;
    const manifest = {
      binary,
      canonicalBinary: binary,
      version,
      launcherSha256,
      nativeSha256,
      executionDigest: execution.digest,
      execution,
      schemaSet,
      sourceKinds,
    };
    await verifyOwnedDirectory(temporaryOwned, guard);
    await guard.race(writeFile(join(temporary, "binary-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" }));
    await verifyOwnedDirectory(temporaryOwned, guard);
    await requireAbsent(destination, guard);
    guard.check();
    await rename(temporary, destination);
    published = true;
    return manifest;
  } catch (error) {
    if (temporaryOwned && !published) {
      if (error.unsettled) {
        const settlement = error.processOutcome?.settled;
        error.cleanup = retainedSchemaCleanup(Boolean(settlement?.then));
        error.deferredCleanup = settlement?.then ? scheduleSchemaCleanup(temporaryOwned, settlement) : null;
      } else {
        error.cleanup = await safeRemoveOwnedDirectory(temporaryOwned);
      }
    }
    throw error;
  } finally {
    guard.dispose();
  }
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  const [binary, output] = process.argv.slice(2);
  if (!binary || !output) throw codedError("EUSAGE", "Usage: node scripts/generate-app-server-schema.mjs <binary> <output>");
  await generateAppServerSchema(binary, output);
}
