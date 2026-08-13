import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  OperationGuard,
  classifyExecutionPath,
  codedError,
  createOwnedDirectory,
  identityOf,
  safeRemoveOwnedDirectory,
  sameIdentity,
  validateLocalPath,
  verifyOwnedDirectory,
} from "./security-policy.js";

const MAX_SHIM_TEXT_BYTES = 2 * 1024 * 1024;

async function readTextBounded(path, guard, maximumBytes = MAX_SHIM_TEXT_BYTES) {
  guard.check();
  const chunks = [];
  let bytes = 0;
  const stream = createReadStream(path, { signal: guard.signal });
  try {
    for await (const chunk of stream) {
      guard.check();
      bytes += chunk.length;
      if (bytes > maximumBytes) throw codedError("EFILETOOLARGE", `Refusing oversized command shim: ${path}`);
      chunks.push(chunk);
    }
  } catch (error) {
    throw guard.kind ? guard.error() : error;
  }
  guard.check();
  return Buffer.concat(chunks).toString("utf8");
}

function platformTarget() {
  const key = `${process.platform}:${process.arch}`;
  return {
    "win32:x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"],
    "win32:arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"],
    "darwin:x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin", "codex"],
    "darwin:arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin", "codex"],
    "linux:x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl", "codex"],
    "linux:arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"],
  }[key] ?? null;
}

async function resolveCodexNativeTarget(targetPath, source, guard) {
  if (basename(targetPath).toLowerCase() !== "codex.js" || !source.includes("PLATFORM_PACKAGE_BY_TARGET")) return null;
  const target = platformTarget();
  if (!target) throw codedError("EUNSUPPORTEDPLATFORM", `Unsupported Codex platform: ${process.platform} (${process.arch})`);
  const [packageName, triple, executableName] = target;
  const require = createRequire(pathToFileURL(targetPath));
  let packageRoot;
  try {
    packageRoot = dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    packageRoot = resolve(dirname(targetPath), "..", "vendor");
  }
  const native = join(packageRoot, "vendor", triple, "bin", executableName);
  return (await validateLocalPath(native, { guard, kind: "file" })).canonicalPath;
}

function npmShimTarget(source) {
  if (!source.includes("%*") || !source.toLowerCase().includes("%dp0%")) return null;
  return source.match(/"%dp0%\\([^"\r\n]+\.(?:[cm]?js))"\s+%\*/iu)?.[1] ?? null;
}

async function resolveNpmShim(executable, guard) {
  const wrapper = await validateLocalPath(executable, { guard, kind: "file" });
  const wrapperPath = wrapper.canonicalPath;
  const source = await readTextBounded(wrapperPath, guard);
  const relativeTarget = npmShimTarget(source);
  if (!relativeTarget) throw codedError("EUNSUPPORTEDCMD", `Refusing unsupported .cmd execution: ${executable}`);
  const wrapperDirectory = dirname(wrapperPath);
  const targetEvidence = await validateLocalPath(resolve(wrapperDirectory, relativeTarget), { guard, kind: "file" });
  const targetPath = targetEvidence.canonicalPath;
  const containment = relative(wrapperDirectory, targetPath);
  if (!containment || containment === ".." || containment.startsWith(`..${sep}`) || isAbsolute(containment)) {
    throw codedError("EUNSUPPORTEDCMD", `Refusing npm shim target outside wrapper directory: ${targetPath}`);
  }
  const targetSource = await readTextBounded(targetPath, guard);
  const codexNative = await resolveCodexNativeTarget(targetPath, targetSource, guard);
  const nativePath = codexNative ?? (await validateLocalPath(process.execPath, { guard, kind: "file" })).canonicalPath;
  return {
    kind: codexNative ? "npm-cmd-shim-native" : "npm-cmd-shim",
    requestedPath: executable,
    wrapperPath,
    targetPath,
    executablePath: nativePath,
    finalNativeTarget: nativePath,
    argvPrefix: codexNative ? [] : [targetPath],
    filePaths: [
      { role: "wrapper", path: wrapperPath },
      { role: "target", path: targetPath },
      { role: "native", path: nativePath },
    ],
  };
}

export async function resolveCommandGuarded(executable, guard) {
  guard.check();
  classifyExecutionPath(executable);
  if (executable.toLowerCase().endsWith(".cmd")) return resolveNpmShim(executable, guard);
  const evidence = await validateLocalPath(executable, { guard, kind: "file" });
  return {
    kind: "native",
    requestedPath: executable,
    executablePath: evidence.canonicalPath,
    finalNativeTarget: evidence.canonicalPath,
    argvPrefix: [],
    filePaths: [{ role: "native", path: evidence.canonicalPath }],
  };
}

async function streamHash(path, guard) {
  guard.check();
  const hash = createHash("sha256");
  const stream = createReadStream(path, { signal: guard.signal });
  try {
    for await (const chunk of stream) {
      guard.check();
      hash.update(chunk);
    }
  } catch (error) {
    throw guard.kind ? guard.error() : error;
  }
  guard.check();
  return hash.digest("hex");
}

async function snapshotFile(file, guard) {
  const pathEvidence = await validateLocalPath(file.path, { guard, kind: "file" });
  const before = identityOf(await guard.race(stat(pathEvidence.canonicalPath, { bigint: true })));
  const sha256 = await streamHash(pathEvidence.canonicalPath, guard);
  const after = identityOf(await guard.race(stat(pathEvidence.canonicalPath, { bigint: true })));
  if (!sameIdentity(before, after)) throw codedError("EIDENTITYCHANGED", `Execution file changed while hashing: ${file.path}`);
  return { ...file, path: pathEvidence.canonicalPath, sha256, fileIdentity: after };
}

function executionDigest(files) {
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${file.role}\0${file.path}\0${file.sha256}\0${JSON.stringify(file.fileIdentity)}\n`);
  return digest.digest("hex");
}

export async function snapshotExecutionGuarded(resolved, guard) {
  const files = [];
  for (const file of resolved.filePaths) files.push(await snapshotFile(file, guard));
  const { filePaths: _filePaths, ...execution } = resolved;
  return { ...execution, files, digest: executionDigest(files) };
}

export async function hashFileStreaming(path, options = {}) {
  const guard = new OperationGuard(options);
  try {
    const evidence = await validateLocalPath(path, { guard, kind: "file" });
    return await streamHash(evidence.canonicalPath, guard);
  } finally {
    guard.dispose();
  }
}

async function copySnapshot(sourceFile, destination, guard) {
  const sourceEvidence = await validateLocalPath(sourceFile.path, { guard, kind: "file" });
  const before = identityOf(await guard.race(stat(sourceEvidence.canonicalPath, { bigint: true })));
  const hash = createHash("sha256");
  const hashingTransform = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        guard.check();
        hash.update(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error);
      }
    },
  });
  try {
    await guard.race(pipeline(
      createReadStream(sourceEvidence.canonicalPath, { signal: guard.signal }),
      hashingTransform,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      { signal: guard.signal },
    ));
  } catch (error) {
    throw guard.kind ? guard.error() : error;
  }
  const after = identityOf(await guard.race(stat(sourceEvidence.canonicalPath, { bigint: true })));
  if (!sameIdentity(before, after)) throw codedError("EIDENTITYCHANGED", `Source changed while staging: ${sourceFile.path}`);
  return { ...sourceFile, path: sourceEvidence.canonicalPath, sha256: hash.digest("hex"), fileIdentity: after };
}

export async function stageExecution(resolved, guard) {
  const owned = await createOwnedDirectory(tmpdir(), "codex-execution-snapshot-", guard);
  try {
    const stageTarget = resolved.kind === "npm-cmd-shim";
    const sourceFiles = [];
    const bindingFiles = [];
    for (let index = 0; index < resolved.filePaths.length; index += 1) {
      const sourceFile = resolved.filePaths[index];
      const shouldStage = sourceFile.role === "native" || (sourceFile.role === "target" && stageTarget);
      if (!shouldStage) {
        sourceFiles.push(await snapshotFile(sourceFile, guard));
        continue;
      }
      const stagedPath = join(owned.canonicalPath, `${index}-${sourceFile.role}${extname(sourceFile.path)}`);
      const sourceSnapshot = await copySnapshot(sourceFile, stagedPath, guard);
      sourceFiles.push(sourceSnapshot);
      await guard.race(chmod(stagedPath, sourceFile.role === "native" ? 0o500 : 0o400));
      const stagedSnapshot = await snapshotFile({ role: sourceFile.role, path: stagedPath }, guard);
      if (sourceSnapshot.sha256 !== stagedSnapshot.sha256) {
        throw codedError("EIDENTITYCHANGED", `Staged bytes differ from hashed source: ${sourceFile.path}`);
      }
      bindingFiles.push({
        role: sourceFile.role,
        sourcePath: sourceFile.path,
        stagedPath,
        beforeSha256: stagedSnapshot.sha256,
        beforeFileIdentity: stagedSnapshot.fileIdentity,
      });
    }
    const { filePaths: _filePaths, ...executionBase } = resolved;
    const execution = { ...executionBase, files: sourceFiles, digest: executionDigest(sourceFiles) };
    return {
      owned,
      execution,
      executablePath: bindingFiles.find(({ role }) => role === "native")?.stagedPath,
      argvPrefix: stageTarget ? [bindingFiles.find(({ role }) => role === "target")?.stagedPath] : [],
      binding: { kind: "private-staged-snapshot", exact: false, files: bindingFiles },
    };
  } catch (error) {
    const cleanup = await safeRemoveOwnedDirectory(owned);
    if (!cleanup.ok) error.cleanup = cleanup;
    throw error;
  }
}

export async function verifyBinding(staged, guard) {
  await verifyOwnedDirectory(staged.owned, guard);
  const files = [];
  for (const file of staged.binding.files) {
    const after = await snapshotFile({ role: file.role, path: file.stagedPath }, guard);
    files.push({ ...file, afterSha256: after.sha256, afterFileIdentity: after.fileIdentity });
  }
  const exact = files.every(({ beforeSha256, afterSha256 }) => beforeSha256 === afterSha256);
  return { kind: staged.binding.kind, exact, files };
}

export function publicBinding(binding) {
  return Object.freeze({
    kind: binding.kind,
    exact: binding.exact,
    files: Object.freeze(binding.files.map(({ role, beforeSha256, afterSha256, beforeFileIdentity, afterFileIdentity }) => Object.freeze({
      role, beforeSha256, afterSha256,
      beforeFileIdentity: beforeFileIdentity ? Object.freeze({ ...beforeFileIdentity }) : null,
      afterFileIdentity: afterFileIdentity ? Object.freeze({ ...afterFileIdentity }) : null,
    }))),
  });
}

export function publicExecution(execution) {
  return Object.freeze({
    kind: execution.kind,
    digest: execution.digest,
    files: Object.freeze(execution.files.map(({ role, sha256, fileIdentity }) => Object.freeze({
      role,
      sha256,
      fileIdentity: fileIdentity ? Object.freeze({ ...fileIdentity }) : null,
    }))),
  });
}

export function nativeSha256(execution) {
  return execution?.files?.find(({ role }) => role === "native")?.sha256 ?? null;
}

export function validateRecipe(recipe) {
  if (!recipe || recipe.kind !== "private-staged-snapshot" || typeof recipe.requestedPath !== "string") {
    throw codedError("EINVALIDRECIPE", "A private staged snapshot recipe is required");
  }
  for (const field of ["expectedExecutionDigest", "expectedNativeSha256", "expectedContextDigest"]) {
    if (typeof recipe[field] !== "string" || !/^[0-9a-f]{64}$/iu.test(recipe[field])) {
      throw codedError("EINVALIDRECIPE", `Recipe is missing ${field}`);
    }
  }
  return recipe;
}

export function assertRecipeMatches(recipe, execution, context) {
  validateRecipe(recipe);
  if (execution.digest !== recipe.expectedExecutionDigest
    || nativeSha256(execution) !== recipe.expectedNativeSha256
    || context.contextDigest !== recipe.expectedContextDigest) {
    throw codedError("ERECIPEMISMATCH", "Fresh execution identity or context does not match the selected recipe");
  }
}

export async function cleanupStaged(staged) {
  return safeRemoveOwnedDirectory(staged.owned);
}
