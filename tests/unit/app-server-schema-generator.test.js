import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateAppServerSchema } from "../../scripts/generate-app-server-schema.mjs";

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

const EXECUTION_A = "d".repeat(64);
const EXECUTION_B = "9".repeat(64);

function execution(digest = EXECUTION_A) {
  return {
    kind: "npm-cmd-shim",
    requestedPath: "codex.cmd",
    executablePath: "node.exe",
    targetPath: "codex.js",
    digest,
    files: [
      { role: "wrapper", path: "codex.cmd", sha256: "a".repeat(64), fileIdentity: { dev: "1", ino: "2" } },
      { role: "target", path: "codex.js", sha256: "b".repeat(64), fileIdentity: { dev: "1", ino: "3" } },
      { role: "native", path: "node.exe", sha256: "c".repeat(64), fileIdentity: { dev: "1", ino: "4" } },
    ],
  };
}

function success(stdout, digest = EXECUTION_A) {
  const currentExecution = execution(digest);
  return {
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    error: null,
    timedOut: false,
    aborted: false,
    identityStable: true,
    sourceStable: true,
    binding: {
      kind: "private-staged-snapshot",
      exact: true,
      files: currentExecution.files.map(({ role, sha256 }) => ({ role, beforeSha256: sha256, afterSha256: sha256 })),
    },
    execution: currentExecution,
    executionContext: { contextDigest: "f".repeat(64), environmentDigest: "e".repeat(64), environmentKeys: ["PATH"] },
  };
}

async function setup(t) {
  const parent = await mkdtemp(join(tmpdir(), "codex schema publication "));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, output: join(parent, "published") };
}

async function writeValidSchema(output) {
  await mkdir(join(output, "v2"), { recursive: true });
  await writeFile(join(output, "v2", "ThreadListParams.json"), JSON.stringify({ properties: { sourceKinds: { items: { $ref: "#/definitions/Kind" } } }, definitions: { Kind: { type: "string", enum: ["cli", "appServer"] } } }), "utf8");
  await writeFile(join(output, "alpha.json"), "{\"type\":\"object\"}\n", "utf8");
}

test("schema generation failures leave no published or temporary directory", async (t) => {
  const { parent, output } = await setup(t);
  const run = async (_binary, args) => {
    if (args[0] === "--version") return success("codex 1\n");
    const temporary = args.at(-1);
    await mkdir(temporary, { recursive: true });
    await writeFile(join(temporary, "partial.json"), "partial", "utf8");
    return { ...success(""), code: 9, stderr: "schema failed" };
  };

  await assert.rejects(generateAppServerSchema("codex.cmd", output, { run }), /schema failed/);
  assert.equal(await pathExists(output), false);
  assert.deepEqual((await readdir(parent)).filter((name) => name.includes(".tmp-")), []);
});

test("an initially unsettled schema child exposes deferred cleanup after confirmed settlement", async (t) => {
  const { parent, output } = await setup(t);
  let resolveSettlement;
  const settled = new Promise((resolve) => { resolveSettlement = resolve; });
  const run = async (_binary, args) => {
    if (args[0] === "--version") return success("codex 1\n");
    await writeFile(join(args.at(-1), "partial.json"), "partial", "utf8");
    return {
      ...success(""),
      code: null,
      error: { name: "Error", code: "ETIMEDOUT", message: "still stopping" },
      unsettled: true,
      settled,
    };
  };

  const rejection = await generateAppServerSchema("codex.cmd", output, { run }).catch((error) => error);
  assert.equal(rejection.code, "ETIMEDOUT");
  assert.equal(rejection.cleanup.deferred, true);
  assert.equal(typeof rejection.deferredCleanup?.then, "function");
  assert.equal((await readdir(parent)).some((name) => name.includes(".tmp-")), true);

  resolveSettlement({ unsettled: false, code: null, signal: "SIGKILL", error: null });
  const deferred = await rejection.deferredCleanup;
  assert.equal(deferred.settlement.unsettled, false);
  assert.equal(deferred.cleanup.ok, true);
  assert.deepEqual((await readdir(parent)).filter((name) => name.includes(".tmp-")), []);
});

test("a permanently unsettled schema child retains its temporary root with explicit evidence", async (t) => {
  const { parent, output } = await setup(t);
  const run = async (_binary, args) => {
    if (args[0] === "--version") return success("codex 1\n");
    await writeFile(join(args.at(-1), "partial.json"), "partial", "utf8");
    return {
      ...success(""),
      code: null,
      error: { name: "Error", code: "ECHILDUNSETTLED", message: "will not settle" },
      unsettled: true,
      settled: null,
    };
  };

  const rejection = await generateAppServerSchema("codex.cmd", output, { run }).catch((error) => error);
  assert.equal(rejection.cleanup.attempted, false);
  assert.equal(rejection.cleanup.deferred, false);
  assert.equal(rejection.cleanup.retained, true);
  assert.equal(rejection.cleanup.error.code, "ECHILDUNSETTLED");
  assert.equal(rejection.deferredCleanup, null);
  assert.equal((await readdir(parent)).some((name) => name.includes(".tmp-")), true);
});

test("schema publication refuses an existing destination without truncating it", async (t) => {
  const { output } = await setup(t);
  await mkdir(output);
  const marker = join(output, "existing.txt");
  await writeFile(marker, "keep", "utf8");

  await assert.rejects(generateAppServerSchema("codex.cmd", output, { run: async () => success("codex 1") }), { code: "EEXIST" });
  assert.equal(await readFile(marker, "utf8"), "keep");
});

test("schema publication safely creates a missing local parent", async (t) => {
  const { parent } = await setup(t);
  const output = join(parent, "new-parent", "published");
  const run = async (_binary, args) => {
    if (args[0] === "--version") return success("codex 1\n");
    await writeValidSchema(args.at(-1));
    return success("");
  };

  const manifest = await generateAppServerSchema("codex.cmd", output, { run });
  assert.equal(manifest.schemaSet.files.length, 2);
  assert.equal(await pathExists(join(output, "binary-manifest.json")), true);
});

test("completed publication records execution chain and deterministic schema digest", async (t) => {
  const { parent, output } = await setup(t);
  const run = async (_binary, args) => {
    if (args[0] === "--version") return success("codex 1\n");
    await writeValidSchema(args.at(-1));
    return success("");
  };

  const manifest = await generateAppServerSchema("codex.cmd", output, { run });
  const published = JSON.parse(await readFile(join(output, "binary-manifest.json"), "utf8"));

  assert.deepEqual(published, manifest);
  assert.equal(published.version, "codex 1");
  assert.deepEqual(published.sourceKinds, ["cli", "appServer"]);
  assert.deepEqual(published.execution.files.map(({ role }) => role), ["wrapper", "target", "native"]);
  assert.deepEqual(published.schemaSet.files.map(({ path }) => path), ["alpha.json", "v2/ThreadListParams.json"]);
  assert.match(published.schemaSet.rawSha256, /^[a-f0-9]{64}$/);
  assert.match(published.schemaSet.semanticSha256, /^[a-f0-9]{64}$/);
  assert.equal(published.launcherSha256, "a".repeat(64));
  assert.equal(published.nativeSha256, "c".repeat(64));
  assert.equal(published.executionDigest, EXECUTION_A);
  assert.equal("sha256" in published, false);
  assert.deepEqual((await readdir(parent)).filter((name) => name.includes(".tmp-")), []);
});

test("execution identity drift between version and schema rejects publication", async (t) => {
  const { output } = await setup(t);
  let call = 0;
  const run = async (_binary, args) => {
    call += 1;
    if (args[0] !== "--version") await writeValidSchema(args.at(-1));
    return success(call === 1 ? "codex 1" : "", call === 1 ? EXECUTION_A : EXECUTION_B);
  };

  await assert.rejects(generateAppServerSchema("codex.cmd", output, { run }), { code: "EIDENTITYCHANGED" });
  assert.equal(await pathExists(output), false);
});

test("truncated version evidence rejects schema generation before publication", async (t) => {
  const { parent } = await setup(t);
  for (const field of ["stdoutTruncated", "stderrTruncated"]) {
    const output = join(parent, field);
    const run = async () => ({ ...success("codex partial"), [field]: true });
    await assert.rejects(generateAppServerSchema("codex.cmd", output, { run }), { code: "EOUTPUTTRUNCATED" });
    assert.equal(await pathExists(output), false);
  }
});

test("schema generation fails closed without an exact execution identity signal", async (t) => {
  const { output } = await setup(t);
  const run = async () => {
    const result = success("codex 1");
    delete result.binding;
    return result;
  };
  await assert.rejects(generateAppServerSchema("codex.cmd", output, { run }), { code: "EIDENTITYMISSING" });
  assert.equal(await pathExists(output), false);
});

test("schema generation requires explicitly stable source and context evidence", async (t) => {
  const { parent } = await setup(t);
  for (const [name, mutate] of [
    ["missing-source-stability", (result) => { delete result.sourceStable; }],
    ["missing-context", (result) => { delete result.executionContext; }],
  ]) {
    const output = join(parent, name);
    const run = async () => {
      const result = success("codex 1");
      mutate(result);
      return result;
    };
    await assert.rejects(generateAppServerSchema("codex.cmd", output, { run }), { code: "EIDENTITYMISSING" });
    assert.equal(await pathExists(output), false);
  }
});

test("schema-set digest is stable across equivalent JSON object key order", async (t) => {
  const { parent } = await setup(t);
  const generate = async (name, aggregate) => generateAppServerSchema("codex.cmd", join(parent, name), {
    run: async (_binary, args) => {
      if (args[0] === "--version") return success("codex 1");
      await writeValidSchema(args.at(-1));
      await writeFile(join(args.at(-1), "aggregate.json"), JSON.stringify(aggregate, null, 2), "utf8");
      return success("");
    },
  });

  const left = await generate("left", { definitions: { Alpha: { type: "string" }, Beta: { type: "number" } } });
  const right = await generate("right", { definitions: { Beta: { type: "number" }, Alpha: { type: "string" } } });

  assert.notEqual(left.schemaSet.files.find(({ path }) => path === "aggregate.json").sha256, right.schemaSet.files.find(({ path }) => path === "aggregate.json").sha256);
  assert.equal(left.schemaSet.semanticSha256, right.schemaSet.semanticSha256);
});

test("semantic schema hashing preserves integers beyond JavaScript safe range", async (t) => {
  const { parent } = await setup(t);
  const generate = async (name, integerLiteral) => generateAppServerSchema("codex.cmd", join(parent, name), {
    run: async (_binary, args) => {
      if (args[0] === "--version") return success("codex 1");
      await writeValidSchema(args.at(-1));
      await writeFile(join(args.at(-1), "large-integer.json"), `{"const":${integerLiteral}}`, "utf8");
      return success("");
    },
  });

  const left = await generate("integer-left", "9007199254740992");
  const right = await generate("integer-right", "9007199254740993");
  const leftFile = left.schemaSet.files.find(({ path }) => path === "large-integer.json");
  const rightFile = right.schemaSet.files.find(({ path }) => path === "large-integer.json");
  assert.notEqual(leftFile.semanticSha256, rightFile.semanticSha256);
  assert.notEqual(left.schemaSet.semanticSha256, right.schemaSet.semanticSha256);
});

test("schema evidence collection rejects oversized files without publication", async (t) => {
  const { output } = await setup(t);
  const run = async (_binary, args) => {
    if (args[0] === "--version") return success("codex 1");
    await writeValidSchema(args.at(-1));
    await writeFile(join(args.at(-1), "oversized.json"), JSON.stringify("x".repeat(8 * 1024 * 1024)), "utf8");
    return success("");
  };
  await assert.rejects(generateAppServerSchema("codex.cmd", output, { run }), { code: "ESCHEMAFILETOOLARGE" });
  assert.equal(await pathExists(output), false);
});

test("schema evidence collection enforces aggregate bytes", async (t) => {
  const { output } = await setup(t);
  const run = async (_binary, args) => {
    if (args[0] === "--version") return success("codex 1");
    await writeValidSchema(args.at(-1));
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(args.at(-1), `aggregate-${index}.json`), JSON.stringify("x".repeat(6 * 1024 * 1024)), "utf8");
    }
    return success("");
  };
  await assert.rejects(generateAppServerSchema("codex.cmd", output, { run }), { code: "ESCHEMATOTALTOOLARGE" });
  assert.equal(await pathExists(output), false);
});

test("schema traversal rejects too many small files", async (t) => {
  const { output } = await setup(t);
  const run = async (_binary, args) => {
    if (args[0] === "--version") return success("codex 1");
    await writeValidSchema(args.at(-1));
    for (let index = 0; index < 513; index += 1) {
      await writeFile(join(args.at(-1), `small-${index}.json`), "{}", "utf8");
    }
    return success("");
  };
  await assert.rejects(generateAppServerSchema("codex.cmd", output, { run }), { code: "ESCHEMAFILECOUNT" });
  assert.equal(await pathExists(output), false);
});

test("schema traversal rejects excessive directory depth", async (t) => {
  const { output } = await setup(t);
  const run = async (_binary, args) => {
    if (args[0] === "--version") return success("codex 1");
    await writeValidSchema(args.at(-1));
    let current = args.at(-1);
    for (let depth = 0; depth < 33; depth += 1) current = join(current, `d${depth}`);
    await mkdir(current, { recursive: true });
    await writeFile(join(current, "deep.json"), "{}", "utf8");
    return success("");
  };
  await assert.rejects(generateAppServerSchema("codex.cmd", output, { run }), { code: "ESCHEMADEPTH" });
  assert.equal(await pathExists(output), false);
});

test("semantic hashing accepts only JSON-defined whitespace", async (t) => {
  const { output } = await setup(t);
  const run = async (_binary, args) => {
    if (args[0] === "--version") return success("codex 1");
    await writeValidSchema(args.at(-1));
    await writeFile(join(args.at(-1), "invalid-whitespace.json"), "{\"value\":\v1}", "utf8");
    return success("");
  };
  await assert.rejects(generateAppServerSchema("codex.cmd", output, { run }), { code: "EINVALIDSCHEMAJSON" });
  assert.equal(await pathExists(output), false);
});

test("schema destination through a junction is rejected", { skip: process.platform !== "win32" }, async (t) => {
  const { parent } = await setup(t);
  const target = join(parent, "real-target");
  const junction = join(parent, "junction");
  await mkdir(target);
  try {
    await symlink(target, junction, "junction");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("junction creation is not permitted");
    throw error;
  }
  let called = false;
  await assert.rejects(generateAppServerSchema("codex.cmd", join(junction, "published"), {
    run: async () => { called = true; return success("codex 1"); },
  }), { code: "EREPARSEPATH" });
  assert.equal(called, false);
});

test("schema temporary root replacement is preserved and never published or recursively deleted", async (t) => {
  const { parent, output } = await setup(t);
  let replacement = null;
  let displaced = null;
  let sentinel = null;
  const run = async (_binary, args) => {
    if (args[0] === "--version") return success("codex 1");
    replacement = args.at(-1);
    await writeValidSchema(replacement);
    displaced = `${replacement}-displaced`;
    await rename(replacement, displaced);
    await mkdir(replacement);
    sentinel = join(replacement, "replacement-sentinel.txt");
    await writeFile(sentinel, "keep", "utf8");
    return success("");
  };
  t.after(async () => {
    if (replacement) await rm(replacement, { recursive: true, force: true });
    if (displaced) await rm(displaced, { recursive: true, force: true });
  });

  await assert.rejects(generateAppServerSchema("codex.cmd", output, { run }), { code: "EROOTIDENTITY" });
  assert.equal(await pathExists(sentinel), true);
  assert.equal(await pathExists(output), false);
  assert.deepEqual((await readdir(parent)).filter((name) => name === "published"), []);
});
