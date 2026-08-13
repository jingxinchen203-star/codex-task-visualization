import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { collectWindowsInventory, parseInventory } from "../../src/windows/inventory.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/windows/inventory.json", import.meta.url));
const scriptPath = fileURLToPath(new URL("../../scripts/windows/inventory.ps1", import.meta.url));
const minimalInventory = { startApps: [], commands: [], errors: [] };

test("inventory keeps uncertainty instead of inventing paths", async () => {
  const raw = JSON.parse(await readFile(fixturePath, "utf8"));
  const value = parseInventory(raw);
  assert.equal(value.package.name, "OpenAI.Codex");
  assert.equal(value.processes[0].path, null);
  assert.deepEqual(value.errors, ["process-path: access denied"]);
});

for (const [field, value, caseName] of [
  ["startApps", undefined, "missing startApps"],
  ["startApps", {}, "non-array startApps"],
  ["commands", undefined, "missing commands"],
  ["commands", {}, "non-array commands"],
  ["errors", undefined, "missing errors"],
  ["errors", {}, "non-array errors"],
]) {
  test(`inventory rejects ${caseName}`, () => {
    const raw = { ...minimalInventory, [field]: value };
    assert.throws(() => parseInventory(raw), {
      name: "TypeError",
      message: "Invalid Windows inventory payload",
    });
  });
}

test("inventory defaults optional identities and stringifies mixed errors", () => {
  const value = parseInventory({ ...minimalInventory, errors: [null, 7, false] });

  assert.equal(value.package, null);
  assert.deepEqual(value.processes, []);
  assert.deepEqual(value.errors, ["null", "7", "false"]);
});

test("collector launches its script by absolute path independent of caller cwd", async () => {
  let invocation;
  const exec = async (...args) => {
    invocation = args;
    return { stdout: '{"package":null,"startApps":[],"processes":[],"commands":[],"errors":[]}' };
  };
  const originalCwd = process.cwd();

  try {
    process.chdir(dirname(process.execPath));
    await collectWindowsInventory(exec);
  } finally {
    process.chdir(originalCwd);
  }

  const [executable, args, options] = invocation;
  const fileIndex = args.indexOf("-File");
  assert.equal(executable, "powershell.exe");
  assert.notEqual(fileIndex, -1);
  assert.equal(isAbsolute(args[fileIndex + 1]), true);
  assert.equal(
    args[fileIndex + 1],
    fileURLToPath(new URL("../../scripts/windows/inventory.ps1", import.meta.url)),
  );
  assert.deepEqual(options, { windowsHide: true, maxBuffer: 1024 * 1024 });
});

test("PowerShell collector records unexpected process discovery failures", async () => {
  const script = await readFile(scriptPath, "utf8");

  assert.match(script, /Get-Process -Name \$name -ErrorAction Stop/);
  assert.match(script, /NoProcessFoundForGivenName/);
  assert.match(script, /\$errors\.Add\("processes\[\$name\]:/);
  assert.doesNotMatch(script, /Get-Process[^\r\n]*SilentlyContinue/);
});

test("PowerShell collector discovers commands independently and records unexpected failures", async () => {
  const script = await readFile(scriptPath, "utf8");

  assert.match(script, /foreach \(\$commandName in @\('codex\.exe','codex\.cmd'\)\)/);
  assert.match(script, /Get-Command \$commandName -All -ErrorAction Stop/);
  assert.match(script, /CommandNotFoundException/);
  assert.match(script, /\$errors\.Add\("commands\[\$commandName\]:/);
  assert.doesNotMatch(script, /Get-Command[^\r\n]*SilentlyContinue/);
  assert.doesNotMatch(script, /Get-Command codex\.exe,codex\.cmd/);
});
