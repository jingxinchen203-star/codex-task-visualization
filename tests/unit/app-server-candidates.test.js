import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCandidates, fingerprintCandidates, rankCandidates, sha256File } from "../../src/app-server/candidates.js";
import { extractThreadSourceKinds } from "../../src/app-server/schema-contract.js";

function stagedVersionResult(overrides = {}) {
  const nativeSha256 = "c".repeat(64);
  return {
    code: 0,
    signal: null,
    stdout: "codex 1",
    stderr: "",
    error: null,
    identityStable: true,
    sourceStable: true,
    binding: {
      kind: "private-staged-snapshot",
      exact: true,
      files: [{ role: "native", beforeSha256: nativeSha256, afterSha256: nativeSha256 }],
    },
    execution: {
      requestedPath: "C:\\source\\codex.exe",
      executablePath: "C:\\source\\codex.exe",
      finalNativeTarget: "C:\\source\\codex.exe",
      digest: "d".repeat(64),
      files: [{ role: "native", path: "C:\\source\\codex.exe", sha256: nativeSha256 }],
    },
    executionContext: {
      environmentDigest: "e".repeat(64),
      contextDigest: "f".repeat(64),
      environmentKeys: ["PATH"],
    },
    ...overrides,
  };
}

test("accessible package helper outranks global CLI", () => {
  const ranked = rankCandidates([
    { path: "E:\\DevTools\\npm-global\\codex.cmd", origin: "global", accessible: true, viable: true },
    { path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\resources\\codex.exe", origin: "package", accessible: true, viable: true },
  ]);
  assert.equal(ranked[0].origin, "package");
});

test("inaccessible package helper remains evidence but is not selected", () => {
  const ranked = rankCandidates([
    { path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\resources\\codex.exe", origin: "package", accessible: false },
    { path: "E:\\DevTools\\npm-global\\codex.cmd", origin: "global", accessible: true },
  ]);
  assert.equal(ranked[0].origin, "global");
  assert.equal(ranked[1].accessible, false);
});

test("viability outranks package preference", () => {
  const ranked = rankCandidates([
    { path: "package.exe", origin: "package", accessible: true, viable: false },
    { path: "codex.cmd", origin: "global", accessible: true, viable: true },
  ]);
  assert.equal(ranked[0].path, "codex.cmd");
});

test("ranking uses a locale-independent case-insensitive path tie-break", () => {
  const ranked = rankCandidates([
    { path: "ä.exe", origin: "global", accessible: true, viable: false },
    { path: "Z.exe", origin: "global", accessible: true, viable: false },
  ]);
  assert.deepEqual(ranked.map(({ path }) => path), ["Z.exe", "ä.exe"]);
});

test("thread source kinds come from the selected binary schema", () => {
  const schema = { properties: { sourceKinds: { items: { $ref: "#/definitions/ThreadSourceKind" } } }, definitions: { ThreadSourceKind: { type: "string", enum: ["cli", "appServer", "subAgent"] } } };
  assert.deepEqual(extractThreadSourceKinds(schema), ["cli", "appServer", "subAgent"]);
  assert.throws(() => extractThreadSourceKinds({ properties: {}, definitions: {} }), /sourceKinds/);
});

test("thread source kinds require a string definition and unique nonempty values", () => {
  const schema = (definition) => ({ properties: { sourceKinds: { items: { $ref: "#/definitions/Kind" } } }, definitions: { Kind: definition } });
  assert.throws(() => extractThreadSourceKinds(schema({ enum: ["cli"] })), /sourceKinds/);
  assert.throws(() => extractThreadSourceKinds(schema({ type: "string", enum: ["cli", "cli"] })), /sourceKinds/);
  assert.throws(() => extractThreadSourceKinds(schema({ type: "string", enum: [""] })), /sourceKinds/);
});

test("thread source kind refs unescape a supported JSON Pointer segment", () => {
  const schema = {
    properties: { sourceKinds: { items: { $ref: "#/definitions/Thread~1Source~0Kind" } } },
    definitions: { "Thread/Source~Kind": { type: "string", enum: ["cli"] } },
  };
  assert.deepEqual(extractThreadSourceKinds(schema), ["cli"]);
});

test("every accessible candidate is fingerprinted and version drift remains visible", async () => {
  const candidates = [{ path: "package.exe", origin: "package", accessible: true }, { path: "codex.cmd", origin: "global", accessible: true }, { path: "denied.exe", origin: "package", accessible: false }];
  const rows = await fingerprintCandidates(candidates, { run: async (path) => stagedVersionResult({ stdout: path === "package.exe" ? "codex 1.0" : "codex 2.0" }), hash: async (path) => `hash:${path}` });
  assert.deepEqual(rows.map(({ version, launcherSha256 }) => [version, launcherSha256]), [["codex 1.0", "hash:package.exe"], ["codex 2.0", "hash:codex.cmd"], [null, null]]);
  assert.equal("sha256" in rows[0], false);
  assert.equal("spawnable" in rows[0], false);
  assert.equal(rows[0].directSpawnable, null);
  assert.equal(rows[0].stagedExecutable, true);
  assert.deepEqual(rows[0].launchRecipe, {
    kind: "private-staged-snapshot",
    requestedPath: "package.exe",
    expectedExecutionDigest: "d".repeat(64),
    expectedNativeSha256: "c".repeat(64),
    expectedContextDigest: "f".repeat(64),
  });
  assert.equal(rows[0].stagedBinding.exact, true);
  assert.equal("stagedPath" in rows[0].launchRecipe, false);
  assert.equal(Object.isFrozen(rows[0].execution), true);
  assert.equal(Object.isFrozen(rows[0].execution.files), true);
  assert.equal("requestedPath" in rows[0].execution, false);
  assert.equal("executablePath" in rows[0].execution, false);
  assert.equal(rows[0].execution.files.some((file) => "path" in file), false);
  assert.throws(() => { rows[0].execution.digest = "0".repeat(64); }, TypeError);
});

test("version success is preserved when hashing fails", async () => {
  const error = Object.assign(new Error("hash denied"), { code: "EACCES" });
  const [row] = await fingerprintCandidates(
    [{ path: "codex.exe", origin: "global", accessible: true }],
    {
      run: async () => stagedVersionResult({ stdout: "codex 3.0\n" }),
      hash: async () => { throw error; },
    },
  );
  assert.equal(row.version, "codex 3.0");
  assert.equal(row.versionOutcome.ok, true);
  assert.equal(row.versionOutcome.code, 0);
  assert.equal(row.launcherSha256, null);
  assert.equal(row.hashOutcome.error.code, "EACCES");
  assert.equal(row.viable, false);
});

test("empty versions are rejected and later candidates still run", async () => {
  const calls = [];
  const rows = await fingerprintCandidates(
    [
      { path: "empty.exe", origin: "package", accessible: true },
      { path: "good.exe", origin: "global", accessible: true },
    ],
    {
      run: async (path) => {
        calls.push(path);
        return stagedVersionResult({ stdout: path === "good.exe" ? "codex 4" : "  " });
      },
      hash: async (path) => `hash:${path}`,
    },
  );
  assert.deepEqual(calls, ["empty.exe", "good.exe"]);
  assert.equal(rows[0].path, "good.exe");
  assert.equal(rows[0].viable, true);
  assert.equal(rows[1].versionOutcome.error.code, "EEMPTYVERSION");
});

test("nonzero version outcomes retain structured process evidence", async () => {
  const [row] = await fingerprintCandidates(
    [{ path: "bad.exe", origin: "global", accessible: true }],
    {
      run: async () => stagedVersionResult({ code: 7, stdout: "partial", stderr: "bad version", stdoutTruncated: false, stderrTruncated: false }),
      hash: async () => "hash",
    },
  );
  assert.deepEqual(
    { code: row.versionOutcome.code, signal: row.versionOutcome.signal, stdout: row.versionOutcome.stdout, stderr: row.versionOutcome.stderr, stdoutTruncated: row.versionOutcome.stdoutTruncated },
    { code: 7, signal: null, stdout: "partial", stderr: "bad version", stdoutTruncated: false },
  );
  assert.equal(row.versionOutcome.error.code, "EVERSIONEXIT");
  assert.equal(row.viable, false);
});

test("truncated version output is rejected while preserving partial evidence", async () => {
  for (const truncatedField of ["stdoutTruncated", "stderrTruncated"]) {
    const [row] = await fingerprintCandidates(
      [{ path: `truncated-${truncatedField}.exe`, origin: "global", accessible: true }],
      {
        run: async () => stagedVersionResult({ stdout: "codex 9", stderr: "warning", stdoutTruncated: false, stderrTruncated: false, [truncatedField]: true }),
        hash: async () => "launcher-hash",
      },
    );
    assert.equal(row.version, null);
    assert.equal(row.versionOutcome.stdout, "codex 9");
    assert.equal(row.versionOutcome.stderr, "warning");
    assert.equal(row.versionOutcome.error.code, "EOUTPUTTRUNCATED");
    assert.equal(row.viable, false);
  }
});

test("candidate viability fails closed without exact and stable execution identity", async () => {
  const inconsistentBinding = stagedVersionResult();
  inconsistentBinding.binding.files[0].afterSha256 = "a".repeat(64);
  for (const result of [
    { code: 0, signal: null, stdout: "codex 9", stderr: "", error: null },
    { code: 0, signal: null, stdout: "codex 9", stderr: "", error: null, identityStable: true, sourceStable: true },
    stagedVersionResult({ stdout: "codex 9", sourceStable: false }),
    stagedVersionResult({ stdout: "codex 9", sourceStable: undefined }),
    stagedVersionResult({ stdout: "codex 9", execution: { digest: "", files: [] } }),
    stagedVersionResult({ stdout: "codex 9", executionContext: null }),
    inconsistentBinding,
  ]) {
    const [row] = await fingerprintCandidates(
      [{ path: "codex.exe", origin: "global", accessible: true }],
      { run: async () => result, hash: async () => "launcher-hash" },
    );
    assert.equal(row.viable, false);
    assert.match(row.versionOutcome.error.code, /^EIDENTITYMISSING$|^EIDENTITYINCONSISTENT$|^ESOURCECHANGED$/u);
  }
});

test("discovery canonicalizes and deduplicates paths while retaining provenance", async () => {
  const canonical = "C:\\Pkg\\app\\resources\\codex.exe";
  const rows = await discoverCandidates(
    {
      package: { name: "OpenAI.Codex", installLocation: "C:\\Pkg" },
      commands: [
        { kind: "Application", name: "codex.exe", source: canonical.toUpperCase(), collector: "Get-Command" },
        { kind: "Application", name: "codex.exe", source: canonical.toLowerCase() },
      ],
    },
    { access: async () => {}, realpath: async () => canonical, validate: async () => null },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].canonicalPath, canonical);
  assert.equal(rows[0].origin, "package");
  assert.deepEqual(rows[0].provenance.map(({ channel }) => channel), ["command", "command", "package"]);
  assert.equal(rows[0].provenance[0].kind, "Application");
  assert.equal(rows[0].provenance[0].collector, "Get-Command");
});

test("discovery rejects a candidate reached through a local junction before following it", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-discovery-locality-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const junction = join(root, "junction");
  await mkdir(target);
  await writeFile(join(target, "codex.exe"), "not-an-executable", "utf8");
  try {
    await symlink(target, junction, "junction");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("junction creation is not permitted");
    throw error;
  }

  const [candidate] = await discoverCandidates({
    package: null,
    commands: [{ kind: "Application", name: "codex.exe", source: join(junction, "codex.exe") }],
  });

  assert.equal(candidate.accessible, false);
  assert.equal(candidate.canonicalization.attempted, false);
  assert.equal(candidate.discoveryErrors[0].code, "EREPARSEPATH");
});

test("discovery separates missing, protected, and canonicalization outcomes", async () => {
  const paths = {
    missing: "C:\\missing\\codex.exe",
    protected: "C:\\protected\\codex.exe",
    canonicalFailure: "C:\\present\\codex.exe",
    disappeared: "C:\\disappeared\\codex.exe",
  };
  const error = (code) => Object.assign(new Error(code), { code });
  const rows = await discoverCandidates(
    {
      package: null,
      commands: Object.entries(paths).map(([name, source]) => ({ name, source })),
    },
    {
      validate: async () => null,
      access: async (path) => {
        if (path === paths.missing) throw error("ENOENT");
        if (path === paths.protected) throw error("EACCES");
      },
      realpath: async (path) => {
        if (path === paths.canonicalFailure) throw error("EPERM");
        if (path === paths.disappeared) throw error("ENOENT");
        return path;
      },
    },
  );
  const bySource = Object.fromEntries(rows.map((row) => [row.provenance[0].source, row]));
  assert.equal(bySource[paths.missing].exists, false);
  assert.equal(bySource[paths.missing].existence.error.code, "ENOENT");
  assert.equal(bySource[paths.protected].exists, null);
  assert.equal(bySource[paths.protected].accessOutcome.error.code, "EACCES");
  assert.equal(bySource[paths.protected].path, paths.protected);
  assert.equal(bySource[paths.canonicalFailure].exists, true);
  assert.equal(bySource[paths.canonicalFailure].accessible, true);
  assert.equal(bySource[paths.canonicalFailure].canonicalPath, null);
  assert.equal(bySource[paths.canonicalFailure].canonicalization.error.code, "EPERM");
  assert.equal(bySource[paths.canonicalFailure].dedupeBasis, "lexical-case-folded");
  assert.equal(bySource[paths.disappeared].exists, false);
  assert.equal(bySource[paths.disappeared].existence.state, "missing");
  assert.equal(bySource[paths.disappeared].canonicalization.error.code, "ENOENT");
});

test("package preference survives discovery through viable fingerprint ranking", async () => {
  const rows = await fingerprintCandidates(
    await discoverCandidates(
      {
        package: { name: "OpenAI.Codex", installLocation: "C:\\Pkg" },
        commands: [{ kind: "Application", name: "codex.cmd", source: "E:\\Tools\\codex.cmd" }],
      },
      { access: async () => {}, realpath: async (path) => path, validate: async () => null },
    ),
    {
      run: async (path) => stagedVersionResult({
        stdout: path.includes("Pkg") ? "codex package" : "codex global",
      }),
      hash: async (path) => `launcher:${path}`,
    },
  );
  assert.equal(rows[0].origin, "package");
  assert.equal(rows[0].version, "codex package");
});

test("a command resolved inside WindowsApps retains factual package preference", async () => {
  const windowsApp = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.0_x64__publisher\\app\\resources\\codex.exe";
  const [candidate] = await discoverCandidates(
    { package: null, commands: [{ kind: "Application", name: "codex.exe", source: windowsApp }] },
    { access: async () => {}, realpath: async (path) => path, validate: async () => null },
  );
  assert.equal(candidate.origin, "package");
  assert.equal(candidate.originEvidence, "windows-app-package-path");
  assert.equal(candidate.provenance[0].channel, "command");
});

test("streaming file hashing honors a pre-aborted signal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex hash abort "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "large.bin");
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 7));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sha256File(path, { signal: controller.signal }), { code: "ABORT_ERR" });
});
