import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const execFileAsync = promisify(execFile);

test("repository ships a durable Windows launcher for the read-only sidebar", () => {
  const launcherPath = join(repositoryRoot, "Start-Codex-Projectboard.cmd");
  assert.equal(existsSync(launcherPath), true, "versioned Windows launcher is missing");

  const launcher = readFileSync(launcherPath, "utf8");
  assert.match(launcher, /scripts\\start-projectboard-sidebar\.ps1/iu);
  assert.match(launcher, /tasklist[^\r\n]*ChatGPT\.exe/iu);
  assert.match(launcher, /Unable to verify whether Codex is running/iu);
  assert.match(launcher, /if errorlevel 1/iu);
  assert.doesNotMatch(
    launcher,
    /remote-debugging-port|user-data-dir|turn\/start|thread\/start|thread\/archive|thread\/delete/iu,
  );
});

test("PowerShell launcher selects one Node executable when PATH contains duplicates", {
  skip: process.platform !== "win32",
}, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "projectboard-node-resolution-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const firstDirectory = join(temporaryRoot, "first node");
  const secondDirectory = join(temporaryRoot, "second node");
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);

  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const executableSeed = join(systemRoot, "System32", "where.exe");
  const firstNode = join(firstDirectory, "node.exe");
  const secondNode = join(secondDirectory, "node.exe");
  await Promise.all([
    copyFile(executableSeed, firstNode),
    copyFile(executableSeed, secondNode),
  ]);

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
  );
  environment.PATH = [firstDirectory, secondDirectory].join(delimiter);
  const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = join(repositoryRoot, "scripts", "start-projectboard-sidebar.ps1");

  let outcome;
  try {
    outcome = { code: 0, ...await execFileAsync(powerShell, [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Check",
    ], { env: environment, windowsHide: true }) };
  } catch (error) {
    outcome = {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
  }

  assert.equal(outcome.code, 0, outcome.stderr);
  const selectedNode = outcome.stdout.trim();
  const [selectedIdentity, expectedIdentity] = await Promise.all([
    stat(selectedNode, { bigint: true }),
    stat(firstNode, { bigint: true }),
  ]);
  assert.deepEqual(
    { dev: selectedIdentity.dev, ino: selectedIdentity.ino },
    { dev: expectedIdentity.dev, ino: expectedIdentity.ino },
    `launcher selected an unexpected executable: ${selectedNode}`,
  );
});

test("PowerShell launcher persists startup diagnostics without changing the controller exit code", {
  skip: process.platform !== "win32",
}, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "projectboard-startup-log-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const fakeNode = join(temporaryRoot, "node.cmd");
  const fakeController = join(temporaryRoot, "fake-controller.mjs");
  const logPath = join(temporaryRoot, "sidebar-startup.log");
  await writeFile(fakeController, [
    'process.stdout.write("控制器诊断：中文输出\\n");',
    'process.stderr.write("侧栏启动失败：回执缺失\\n");',
    "process.exitCode = 23;",
    "",
  ].join("\n"), "utf8");
  await writeFile(fakeNode, [
    "@echo off",
    `"${process.execPath}" "${fakeController}"`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n"), "utf8");

  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
  );
  environment.PATH = temporaryRoot;
  const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = join(repositoryRoot, "scripts", "start-projectboard-sidebar.ps1");

  let outcome;
  try {
    outcome = { code: 0, ...await execFileAsync(powerShell, [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-LogPath",
      logPath,
    ], { env: environment, windowsHide: true }) };
  } catch (error) {
    outcome = {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
  }

  assert.equal(outcome.code, 23, `${outcome.stdout}\n${outcome.stderr}`);
  const diagnostics = await readFile(logPath, "utf8");
  assert.match(diagnostics, /控制器诊断：中文输出/u);
  assert.match(diagnostics, /侧栏启动失败：回执缺失/u);
  assert.doesNotMatch(diagnostics, /鎺у埗|渚ф爮/u);
  assert.match(diagnostics, /exit code: 23/iu);
  assert.match(`${outcome.stdout}\n${outcome.stderr}`, /diagnostic log:/iu);
});
