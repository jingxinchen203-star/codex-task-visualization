import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bindPhase0Candidate,
  findLatestPhase0IdentityLock,
  loadPhase0IdentityLock,
  resolveReadonlyPackageBinding,
} from "../../src/phase-1/identity-lock.js";

const lockedPath = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.803.5235.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe";

function report(runId = "run-1", overrides = {}) {
  const selected = {
    origin: "package",
    path: lockedPath,
    canonicalPath: lockedPath,
    viable: true,
    version: "codex-cli test",
    launcherSha256: "b".repeat(64),
    nativeSha256: "c".repeat(64),
    executionDigest: "d".repeat(64),
  };
  const evidence = {
    selected,
    schema: {
      version: selected.version,
      executionDigest: selected.executionDigest,
      launcherSha256: selected.launcherSha256,
      nativeSha256: selected.nativeSha256,
      sourceKinds: ["vscode", "appServer"],
    },
    identity: { initialized: true, accountType: "chatgpt", activeCount: 1, archivedCount: 2 },
  };
  return {
    schemaVersion: 1,
    runId,
    gates: [{ id: "app_server_identity", status: "fail", evidence: [evidence] }],
    phases: {
      standalonePhase1: "go-with-readonly-degradation",
      injectedPhase1: "no-go",
      phase2: "no-go",
      phase3: "blocked-by-git-gate",
    },
    ...overrides,
  };
}

async function writeSealedReport(root, name, value) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "report.json"), JSON.stringify(value), "utf8");
  await writeFile(join(directory, ".report-sealed"), `${value.runId}\n`, "utf8");
  return directory;
}

test("a sealed Phase 0 report becomes a read-only identity lock even when execution gates are no-go", async () => {
  const root = await mkdtemp(join(tmpdir(), "projectboard-phase1-lock-"));
  const directory = await writeSealedReport(root, "2026-08-10-valid", report());
  const lock = await loadPhase0IdentityLock(directory);

  assert.deepEqual(lock, {
    reportDirectory: directory,
    phase0RunId: "run-1",
    standalonePhase1: "go-with-readonly-degradation",
    injectedPhase1: "no-go",
    accountType: "chatgpt",
    candidate: {
      path: lockedPath,
      canonicalPath: lockedPath,
      version: "codex-cli test",
      launcherSha256: "b".repeat(64),
      nativeSha256: "c".repeat(64),
      executionDigest: "d".repeat(64),
    },
    sourceKinds: ["vscode", "appServer"],
  });
  assert.equal(Object.isFrozen(lock), true);
  assert.equal(Object.isFrozen(lock.candidate), true);
  assert.equal(Object.isFrozen(lock.sourceKinds), true);
});

test("identity lock discovery skips malformed or no-go reports and chooses the newest usable seal", async () => {
  const root = await mkdtemp(join(tmpdir(), "projectboard-phase1-locks-"));
  await writeSealedReport(root, "2026-08-09-valid", report("older"));
  await writeSealedReport(root, "2026-08-10-no-go", report("blocked", {
    phases: { ...report().phases, standalonePhase1: "no-go" },
  }));
  const latest = await writeSealedReport(root, "2026-08-11-valid", report("newer"));
  const lock = await findLatestPhase0IdentityLock(root);
  assert.equal(lock.reportDirectory, latest);
  assert.equal(lock.phase0RunId, "newer");

  await writeFile(join(latest, ".report-sealed"), "wrong-run\n", "utf8");
  const fallback = await findLatestPhase0IdentityLock(root);
  assert.equal(fallback.phase0RunId, "older");
});

test("candidate binding fingerprints only the package path named by the lock and fails on drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "projectboard-phase1-bind-"));
  const lock = await loadPhase0IdentityLock(await writeSealedReport(root, "lock", report()));
  const discovered = [
    { path: lockedPath, canonicalPath: lockedPath, origin: "package", accessible: true },
    { path: "E:\\bin\\codex.cmd", canonicalPath: "E:\\bin\\codex.cmd", origin: "global", accessible: true },
  ];
  let fingerprintInput = null;
  const candidate = {
    ...discovered[0],
    viable: true,
    version: lock.candidate.version,
    launcherSha256: lock.candidate.launcherSha256,
    nativeSha256: lock.candidate.nativeSha256,
    executionDigest: lock.candidate.executionDigest,
    launchRecipe: { kind: "private-staged-snapshot", expectedContextDigest: "e".repeat(64) },
  };
  const bound = await bindPhase0Candidate(lock, {
    collectInventory: async () => ({ package: {}, commands: [] }),
    discover: async () => discovered,
    fingerprint: async (input) => { fingerprintInput = input; return [candidate]; },
  });
  assert.deepEqual(fingerprintInput, [discovered[0]]);
  assert.equal(bound, candidate);

  await assert.rejects(
    bindPhase0Candidate(lock, {
      collectInventory: async () => ({}),
      discover: async () => discovered,
      fingerprint: async () => [{ ...candidate, executionDigest: "f".repeat(64) }],
    }),
    (error) => error.code === "EIDENTITYDRIFT",
  );
});

test("a unique same-family package upgrade is rebound through its own generated schema for read-only use", async () => {
  const root = await mkdtemp(join(tmpdir(), "projectboard-phase1-upgrade-"));
  const lock = await loadPhase0IdentityLock(await writeSealedReport(root, "lock", report()));
  const currentPath = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.803.10989.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe";
  const discovered = [
    { path: currentPath, canonicalPath: currentPath, origin: "package", accessible: true },
    { path: "E:\\bin\\codex.cmd", canonicalPath: "E:\\bin\\codex.cmd", origin: "global", accessible: true },
  ];
  const candidate = {
    ...discovered[0],
    viable: true,
    version: "codex-cli upgraded",
    launcherSha256: "1".repeat(64),
    nativeSha256: "2".repeat(64),
    executionDigest: "3".repeat(64),
    launchRecipe: { kind: "private-staged-snapshot", expectedContextDigest: "4".repeat(64) },
  };
  let fingerprintInput = null;
  let generatedPath = null;
  const binding = await resolveReadonlyPackageBinding(lock, {
    collectInventory: async () => ({}),
    discover: async () => discovered,
    fingerprint: async (input) => { fingerprintInput = input; return [candidate]; },
    withSchemaDirectory: async (callback) => callback("C:\\owned-schema"),
    generateSchema: async (path, directory) => {
      generatedPath = [path, directory];
      return {
        version: candidate.version,
        launcherSha256: candidate.launcherSha256,
        nativeSha256: candidate.nativeSha256,
        executionDigest: candidate.executionDigest,
        sourceKinds: ["vscode", "futureKind"],
      };
    },
    readSourceKinds: async () => ["vscode", "futureKind"],
  });

  assert.deepEqual(fingerprintInput, [discovered[0]]);
  assert.deepEqual(generatedPath, [currentPath, "C:\\owned-schema"]);
  assert.deepEqual(binding, {
    candidate,
    sourceKinds: ["vscode", "futureKind"],
    continuity: "same-package-upgrade-readonly",
  });
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.sourceKinds), true);
});
