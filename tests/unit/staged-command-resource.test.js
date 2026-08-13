import test from "node:test";
import assert from "node:assert/strict";
import { access, appendFile, chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareStagedCommand, runCommand } from "../../src/process/run-command.js";

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

function recipeFrom(path, result) {
  return {
    kind: "private-staged-snapshot",
    requestedPath: path,
    expectedExecutionDigest: result.execution.digest,
    expectedNativeSha256: result.execution.files.find(({ role }) => role === "native").sha256,
    expectedContextDigest: result.executionContext.contextDigest,
  };
}

async function recipeFor(path, options = {}) {
  const result = await runCommand(path, ["--version"], { timeoutMs: 10_000, ...options });
  assert.equal(result.code, 0);
  return recipeFrom(path, result);
}

async function withOwnedTempRoot(t) {
  const ambientTemp = tmpdir();
  const root = await mkdtemp(join(ambientTemp, "codex-owned-root-"));
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  process.env.TEMP = root;
  process.env.TMP = root;
  t.after(async () => {
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function onlyStageDirectory(root) {
  const names = (await readdir(root)).filter((name) => name.startsWith("codex-execution-snapshot-"));
  assert.equal(names.length, 1);
  return join(root, names[0]);
}

test("owned launch hides stage paths, permits one child, and refuses premature dispose", async (t) => {
  await withOwnedTempRoot(t);
  const recipe = await recipeFor(process.execPath);
  const resource = await prepareStagedCommand(recipe, { timeoutMs: 10_000 });
  t.after(() => resource.dispose().catch(() => {}));

  assert.equal("stageDirectory" in resource, false);
  assert.equal("executablePath" in resource, false);
  assert.equal("argvPrefix" in resource, false);
  assert.equal(JSON.stringify(resource).includes("codex-execution-snapshot-"), false);
  assert.equal("executablePath" in resource.execution, false);
  assert.equal(resource.execution.files.some((file) => "path" in file), false);
  assert.throws(() => { resource.execution.digest = "0".repeat(64); }, TypeError);
  assert.throws(() => { resource.binding.files.push({}); }, TypeError);
  assert.throws(() => { resource.executionContext.environmentKeys.push("NODE_OPTIONS"); }, TypeError);

  const ownedChild = await resource.spawn(["-e", "setTimeout(() => {}, 150)"]);
  assert.equal("spawnfile" in ownedChild, false);
  assert.ok(ownedChild.stdout);
  assert.ok(ownedChild.stderr);
  await assert.rejects(resource.dispose(), { code: "ECHILDACTIVE" });
  await assert.rejects(resource.spawn(["--version"]), { code: "EALREADYSPAWNED" });

  const settlement = await ownedChild.settlement;
  assert.equal(settlement.code, 0);
  assert.equal(settlement.unsettled, false);
  const first = await resource.dispose();
  const second = await resource.dispose();
  assert.deepEqual(second, first);
  assert.equal(first.cleanup.ok, true);
});

test("fresh preparation rejects a mismatched durable recipe without leaking staging", async (t) => {
  const root = await withOwnedTempRoot(t);
  const recipe = await recipeFor(process.execPath);
  recipe.expectedNativeSha256 = "0".repeat(64);

  await assert.rejects(prepareStagedCommand(recipe, { timeoutMs: 10_000 }), { code: "ERECIPEMISMATCH" });
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("codex-execution-snapshot-")), []);
});

test("unrelated cwd content changes do not invalidate a context-bound recipe", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "codex-stable-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const recipe = await recipeFor(process.execPath, { cwd });
  await writeFile(join(cwd, "unrelated.txt"), "content changed", "utf8");

  const resource = await prepareStagedCommand(recipe, { cwd, timeoutMs: 10_000 });
  const disposal = await resource.dispose();
  assert.equal(disposal.cleanup.ok, true);
});

test("replacing the cwd directory invalidates a context-bound recipe", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "codex-replaced-cwd-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const cwd = join(parent, "cwd");
  const displaced = join(parent, "displaced");
  await mkdir(cwd);
  const recipe = await recipeFor(process.execPath, { cwd });
  await rename(cwd, displaced);
  await mkdir(cwd);

  await assert.rejects(
    prepareStagedCommand(recipe, { cwd, timeoutMs: 10_000 }),
    { code: "ERECIPEMISMATCH" },
  );
});

test("source mutation after preparation is rejected immediately before spawn", { skip: process.platform !== "win32" }, async (t) => {
  await withOwnedTempRoot(t);
  const directory = await mkdtemp(join(tmpdir(), "codex-owned-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target.mjs");
  const shim = join(directory, "codex.cmd");
  await writeFile(target, "console.log('original');\n", "utf8");
  await writeFile(shim, `@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\target.mjs" %*\r\n`, "utf8");
  const recipe = await recipeFor(shim);
  const resource = await prepareStagedCommand(recipe, { timeoutMs: 10_000 });
  t.after(() => resource.dispose().catch(() => {}));
  await appendFile(target, "console.log('mutated');\n", "utf8");

  await assert.rejects(resource.spawn([]), { code: "ERECIPEMISMATCH" });
  await resource.dispose().catch(() => {});
});

test("staged-byte mutation is detected before spawn without a public stage path", async (t) => {
  const root = await withOwnedTempRoot(t);
  const recipe = await recipeFor(process.execPath);
  const resource = await prepareStagedCommand(recipe, { timeoutMs: 10_000 });
  t.after(() => resource.dispose().catch(() => {}));
  const stage = await onlyStageDirectory(root);
  const [stagedFile] = await readdir(stage);
  const stagedPath = join(stage, stagedFile);
  await chmod(stagedPath, 0o600);
  await appendFile(stagedPath, Buffer.from([0]));

  await assert.rejects(resource.spawn(["--version"]), { code: "EIDENTITYCHANGED" });
  await resource.dispose().catch(() => {});
  assert.equal(await pathExists(stage), false);
});

test("owned root replacement is not recursively deleted", async (t) => {
  const root = await withOwnedTempRoot(t);
  const recipe = await recipeFor(process.execPath);
  const resource = await prepareStagedCommand(recipe, { timeoutMs: 10_000 });
  const stage = await onlyStageDirectory(root);
  const displaced = `${stage}-displaced`;
  await rename(stage, displaced);
  await mkdir(stage);
  const sentinel = join(stage, "replacement-sentinel.txt");
  await writeFile(sentinel, "keep", "utf8");
  t.after(() => rm(displaced, { recursive: true, force: true }));

  await assert.rejects(resource.dispose(), { code: "EROOTIDENTITY" });
  assert.equal(await pathExists(sentinel), true);
});

test("owned launch abort settles before disposal", async (t) => {
  await withOwnedTempRoot(t);
  const controller = new AbortController();
  const recipe = await recipeFor(process.execPath);
  const resource = await prepareStagedCommand(recipe, { timeoutMs: 10_000, signal: controller.signal });
  t.after(() => resource.dispose().catch(() => {}));
  const ownedChild = await resource.spawn(["-e", "setTimeout(() => {}, 30_000)"]);
  setTimeout(() => controller.abort(), 30);

  const settlement = await ownedChild.settlement;
  assert.equal(settlement.aborted, true);
  assert.equal(settlement.unsettled, false);
  const disposal = await resource.dispose();
  assert.equal(disposal.cleanup.ok, true);
});
