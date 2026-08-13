import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "../../src/process/run-command.js";

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function stagedSnapshotDirectories() {
  return new Set((await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("codex-execution-snapshot-"))
    .map(({ name }) => name));
}

async function makeNpmShim(t, targetSource) {
  const directory = await mkdtemp(join(tmpdir(), "codex shim (safe) "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target.mjs");
  const shim = join(directory, "codex tool.cmd");
  await writeFile(target, targetSource, "utf8");
  await writeFile(shim, `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\target.mjs" %*\r\n`, "utf8");
  return { directory, shim, target };
}

test("npm cmd shims bypass cmd parsing and preserve hostile Windows arguments", { skip: process.platform !== "win32" }, async (t) => {
  const { directory, shim } = await makeNpmShim(t, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const sentinel = join(directory, "must not exist.txt");
  const args = [
    "two words", "amp&ersand", "%PATH%", "!PATH!", "caret^", "(parentheses)",
    'embedded"quote', "C:\\path with space\\trailing\\", `& echo injected>"${sentinel}"`,
  ];

  const result = await runCommand(shim, args, { timeoutMs: 5_000 });

  assert.equal(result.code, 0);
  assert.equal(result.error, null);
  assert.deepEqual(JSON.parse(result.stdout.trim()), args);
  assert.equal(await pathExists(sentinel), false);
  assert.equal(result.execution.kind, "npm-cmd-shim");
  assert.deepEqual(result.execution.files.map(({ role }) => role), ["wrapper", "target", "native"]);
  assert.equal(result.execution.files.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)), true);
});

test("runCommand returns immutable execution evidence without source or staged paths", async () => {
  const result = await runCommand(process.execPath, ["--version"], { timeoutMs: 10_000 });
  for (const evidence of [result.execution, result.executionAfter]) {
    assert.ok(evidence);
    assert.equal(Object.isFrozen(evidence), true);
    assert.equal(Object.isFrozen(evidence.files), true);
    for (const field of ["requestedPath", "wrapperPath", "targetPath", "executablePath", "finalNativeTarget", "path"]) {
      assert.equal(field in evidence, false);
    }
    assert.equal(evidence.files.some((file) => "path" in file), false);
    assert.throws(() => { evidence.digest = "0".repeat(64); }, TypeError);
    assert.throws(() => { evidence.files.push({}); }, TypeError);
  }
});

test("generic cmd files fail closed without executing a sentinel", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex generic cmd "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentinel = join(directory, "sentinel.txt");
  const generic = join(directory, "generic.cmd");
  await writeFile(generic, `@echo owned>"${sentinel}"\r\n`, "utf8");

  await assert.rejects(runCommand(generic, ["a&b"]), { code: "EUNSUPPORTEDCMD" });
  assert.equal(await pathExists(sentinel), false);
});

test("runCommand rejects shell overrides before a sentinel can execute", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex unsafe spawn option "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentinel = join(directory, "sentinel.txt");
  const script = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'owned')`;

  await assert.rejects(runCommand(process.execPath, ["-e", script], { shell: true }), { code: "EUNSAFESPAWNOPTION" });
  assert.equal(await pathExists(sentinel), false);
});

test("explicit NODE_OPTIONS poisoning is rejected before its sentinel executes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-explicit-node-options-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentinel = join(directory, "explicit-sentinel.txt");
  const hook = join(directory, "hook.cjs");
  await writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'owned')`, "utf8");

  await assert.rejects(
    runCommand(process.execPath, ["-e", "console.log('safe')"], {
      env: { ...process.env, NODE_OPTIONS: `--require=${hook}` },
    }),
    { code: "EUNSAFESPAWNOPTION" },
  );
  assert.equal(await pathExists(sentinel), false);
});

test("inherited NODE_OPTIONS poisoning is stripped and controlled context is evidenced", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-inherited-node-options-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentinel = join(directory, "inherited-sentinel.txt");
  const hook = join(directory, "hook.cjs");
  await writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'owned')`, "utf8");
  const previous = process.env.NODE_OPTIONS;
  const previousNodePath = process.env.NODE_PATH;
  process.env.NODE_OPTIONS = `--require=${hook}`;
  process.env.NODE_PATH = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    if (previousNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = previousNodePath;
  });

  const result = await runCommand(process.execPath, ["-e", "console.log(process.env.NODE_OPTIONS === undefined && process.env.NODE_PATH === undefined ? 'safe' : 'poisoned')"], { timeoutMs: 10_000 });

  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "safe");
  assert.equal(await pathExists(sentinel), false);
  assert.match(result.executionContext.environmentDigest, /^[a-f0-9]{64}$/u);
  assert.match(result.executionContext.contextDigest, /^[a-f0-9]{64}$/u);
  assert.equal(result.executionContext.environmentKeys.includes("NODE_OPTIONS"), false);
  assert.equal(result.executionContext.environmentKeys.includes("NODE_PATH"), false);
});

test("a reparse working directory is rejected before staging", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex cwd locality "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target");
  const junction = join(directory, "junction");
  await mkdir(target);
  try {
    await symlink(target, junction, "junction");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("junction creation is not permitted");
    throw error;
  }

  await assert.rejects(runCommand(process.execPath, ["--version"], { cwd: junction }), { code: "EREPARSEPATH" });
});

test("a reparse staging root is rejected before executable bytes are copied", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-stage-locality-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target");
  const junction = join(directory, "junction");
  await mkdir(target);
  try {
    await symlink(target, junction, "junction");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("junction creation is not permitted");
    throw error;
  }
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  process.env.TEMP = junction;
  process.env.TMP = junction;
  try {
    await assert.rejects(runCommand(process.execPath, ["--version"]), { code: "EREPARSEPATH" });
    assert.deepEqual(await readdir(target), []);
  } finally {
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
  }
});

test("a pre-aborted operation returns before path resolution or hashing", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCommand(join(tmpdir(), "definitely-missing-large.exe"), [], { signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.error.code, "ABORT_ERR");
  assert.equal(result.execution, null);
});

test("one deadline covers resolution before any process is spawned", async () => {
  const before = await stagedSnapshotDirectories();
  const started = Date.now();
  const result = await runCommand(
    process.execPath,
    ["--version"],
    { timeoutMs: 1 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(Date.now() - started < 150, true);
  const after = await stagedSnapshotDirectories();
  assert.deepEqual([...after].filter((name) => !before.has(name)), []);
});

test("command output is bounded and timeout is reported structurally", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 4000)"],
    { timeoutMs: 2_000, maxOutputBytes: 128 },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.stdoutTruncated, true);
  assert.equal(Buffer.byteLength(result.stdout), 128);
  assert.equal(result.stdoutBytes, 4096);
});

test("abort is reported without rejecting after a child starts", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 25);
  const result = await runCommand(
    process.execPath,
    ["-e", "setTimeout(() => {}, 250)"],
    { timeoutMs: 5_000, signal: controller.signal },
  );
  assert.equal(result.aborted, true);
  assert.equal(result.error.code, "ABORT_ERR");
});

test("timeout settles an owned child and grandchild tree before cleanup", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-owned-tree-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "grandchild.pid");
  t.after(async () => {
    try {
      const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid);
    } catch {}
  });
  const script = `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' });
writeFileSync(process.argv[1], String(grandchild.pid));
setTimeout(() => {}, 30000);`;

  const result = await runCommand(process.execPath, ["-e", script, pidFile], { timeoutMs: 2_500 });

  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.termination.requested, true);
  assert.equal(result.termination.scope, "process-tree");
  assert.equal(result.termination.graceExpired, false, JSON.stringify(result, null, 2));
  assert.equal(result.unsettled, false);
  assert.equal(result.cleanup.ok, true);
  const grandchildPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
  assert.throws(() => process.kill(grandchildPid, 0));
});

test("spawn failures retain the resolved execution identity", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["--version"], { cwd: join(tmpdir(), "definitely-missing-cwd") }),
    { code: "ENOENT" },
  );
});

test("the executed bytes come from a private staged snapshot", { skip: process.platform !== "win32" }, async (t) => {
  const { shim, target } = await makeNpmShim(t, "console.log('placeholder');\n");
  await writeFile(target, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(target)}, "console.log('source-mutated');\\n", 'utf8');\nconsole.log('snapshot-original');\n`, "utf8");
  const result = await runCommand(
    shim,
    [],
    { timeoutMs: 10_000 },
  );

  assert.equal(result.stdout.trim(), "snapshot-original");
  assert.equal(result.error, null);
  assert.equal(result.binding.kind, "private-staged-snapshot");
  assert.equal(result.binding.exact, true);
  assert.equal(result.binding.files.every(({ beforeSha256, afterSha256 }) => beforeSha256 === afterSha256), true);
  assert.equal(await pathExists(result.binding.stageDirectory), false);
});

test("source identity drift remains evidence without changing staged execution bytes", { skip: process.platform !== "win32" }, async (t) => {
  const { shim } = await makeNpmShim(t, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], '\\r\\nrem changed');\nconsole.log('codex 1.0');\n");

  const result = await runCommand(shim, [shim], { timeoutMs: 5_000 });

  assert.equal(result.code, 0);
  assert.equal(result.sourceStable, false);
  assert.equal(result.binding.exact, true);
  assert.equal(result.error, null);
});

test("post-verification failure preserves child exit and output evidence", { skip: process.platform !== "win32" }, async (t) => {
  const { shim } = await makeNpmShim(t, "import { rmSync } from 'node:fs';\nrmSync(process.argv[2]);\nconsole.log('preserve-me');\n");

  const result = await runCommand(shim, [shim], { timeoutMs: 10_000 });

  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "preserve-me");
  assert.equal(result.stderr, "");
  assert.equal(result.postVerification.ok, false);
  assert.equal(result.postVerification.error.code, "ENOENT");
  assert.equal(result.cleanup.ok, true);
});
