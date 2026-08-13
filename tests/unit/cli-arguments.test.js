import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createDefaultProbes,
  main,
  parseArguments,
  withOwnedSchemaDirectory,
} from "../../src/cli.js";
import { runPhase0 } from "../../src/orchestrator.js";

const absoluteFixture = path.resolve("fixtures", "phase-0-live");

test("readonly is the only implicit mode", () => {
  const expected = {
    mode: "readonly",
    allowCodexRestart: false,
    probeExistingInstance: false,
    allowPersistentThread: false,
    allowModelTurns: false,
    fixtureCwd: null,
  };
  assert.deepEqual(parseArguments([]), expected);
  assert.deepEqual(parseArguments(["readonly"]), expected);
  assert.throws(() => parseArguments(["readonly", "--allow-codex-restart"]), /readonly/u);
  assert.throws(() => parseArguments(["readonly", "--probe-existing-instance"]), /readonly/u);
});

test("live mutation flags are strict, paired, and unambiguous", () => {
  assert.throws(() => parseArguments(["live", "--allow-model-turns"]), /persistent thread/u);
  assert.throws(() => parseArguments(["live", "--allow-persistent-thread"]), /model turns/u);
  assert.throws(
    () => parseArguments(["live", "--allow-codex-restart", "--probe-existing-instance"]),
    /mutually exclusive/u,
  );
  assert.throws(() => parseArguments(["live", "--unknown"]), /unknown argument/u);
  assert.throws(() => parseArguments(["live", "--fixture-cwd"]), /requires a value/u);
  assert.throws(() => parseArguments(["live", "--fixture-cwd", "relative"]), /absolute/u);
  assert.throws(() => parseArguments([
    "live",
    "--allow-persistent-thread",
    "--allow-model-turns",
    "--fixture-cwd",
    "\\\\server\\share\\phase-0",
  ]), /network|device|local/u);
  assert.throws(() => parseArguments(["live", "--fixture-cwd", absoluteFixture]), /model turns/u);
  assert.throws(
    () => parseArguments(["live", "--allow-codex-restart", "--allow-codex-restart"]),
    /duplicate/u,
  );

  assert.deepEqual(parseArguments([
    "live",
    "--allow-persistent-thread",
    "--allow-model-turns",
    "--fixture-cwd",
    absoluteFixture,
  ]), {
    mode: "live",
    allowCodexRestart: false,
    probeExistingInstance: false,
    allowPersistentThread: true,
    allowModelTurns: true,
    fixtureCwd: absoluteFixture,
  });
});

test("default readonly probes never enter live, activation, or network-security paths", async () => {
  const calls = [];
  const candidate = {
    path: "C:\\Codex\\codex.exe",
    canonicalPath: "C:\\Codex\\codex.exe",
    origin: "package",
    viable: true,
    version: "codex-cli 1.0.0",
    launcherSha256: "a".repeat(64),
    nativeSha256: "b".repeat(64),
    executionDigest: "c".repeat(64),
    launchRecipe: { kind: "private-staged-snapshot" },
  };
  const options = { ...parseArguments(["readonly"]), runId: "readonly-run" };
  const probes = createDefaultProbes(options, {
    collectInventory: async () => {
      calls.push("inventory");
      return { package: { installLocation: "C:\\Codex" }, startApps: [{}], commands: [{}], errors: [] };
    },
    discover: async () => { calls.push("discover"); return [{ path: candidate.path }]; },
    fingerprint: async () => {
      calls.push("fingerprint");
      return [candidate, {
        ...candidate,
        path: "C:\\global\\codex.cmd",
        canonicalPath: null,
        origin: "global",
        viable: false,
        accessible: false,
        exists: null,
        version: null,
        launcherSha256: null,
        nativeSha256: null,
        executionDigest: null,
        fingerprintError: "inaccessible",
      }];
    },
    withSchemaDirectory: async (callback) => {
      calls.push("schema-workspace");
      return callback("C:\\schema");
    },
    generateSchema: async () => {
      calls.push("schema-generate");
      return {
        version: candidate.version,
        executionDigest: candidate.executionDigest,
        nativeSha256: candidate.nativeSha256,
        schemaSet: { rawSha256: "d".repeat(64), semanticSha256: "e".repeat(64), files: [] },
        sourceKinds: ["cli"],
      };
    },
    readSourceKinds: async () => { calls.push("source-kinds"); return ["cli"]; },
    probeIdentity: async () => {
      calls.push("identity");
      return { initialized: true, activeCount: 0, archivedCount: 0, outboundMethods: [] };
    },
    probeDispatch: async () => { calls.push("dispatch"); return { status: "pass" }; },
    runLive: async () => { calls.push("LIVE-MUST-NOT-RUN"); throw new Error("live called"); },
  });
  const report = await runPhase0(options, probes);
  assert.deepEqual(calls, [
    "inventory",
    "discover",
    "fingerprint",
    "schema-workspace",
    "schema-generate",
    "source-kinds",
    "identity",
    "dispatch",
  ]);
  assert.equal(report.gates.find(({ id }) => id === "app_server_identity").status, "inconclusive");
  const appEvidence = report.gates.find(({ id }) => id === "app_server_identity").evidence[0];
  assert.equal(appEvidence.candidates.length, 2);
  assert.equal(appEvidence.candidates[1].viable, false);
  assert.equal(appEvidence.candidates[1].fingerprintError, "inaccessible");
  assert.deepEqual(
    report.gates.filter(({ id }) => ["secure_injection", "local_api_security"].includes(id)).map(({ status }) => status),
    ["skipped", "skipped"],
  );
  assert.equal(calls.includes("LIVE-MUST-NOT-RUN"), false);
});

test("live probe canonicalizes its fixture and wires only fixed consent callbacks", async () => {
  const candidate = {
    path: "C:\\Codex\\codex.exe",
    canonicalPath: "C:\\Codex\\codex.exe",
    origin: "package",
    viable: true,
    version: "codex-cli 1.0.0",
    launcherSha256: "a".repeat(64),
    nativeSha256: "b".repeat(64),
    executionDigest: "c".repeat(64),
    launchRecipe: { kind: "private-staged-snapshot" },
  };
  const fixture = path.resolve("fixtures", "phase-0-live");
  const canonicalFixture = path.resolve("fixtures", "phase-0-live-canonical");
  const options = {
    ...parseArguments([
      "live",
      "--allow-persistent-thread",
      "--allow-model-turns",
      "--fixture-cwd",
      fixture,
    ]),
    runId: "live-run",
  };
  const confirmDesktop = async () => true;
  const displayApproval = async () => {};
  let liveCall = null;
  const probes = createDefaultProbes(options, {
    collectInventory: async () => ({ package: {}, startApps: [{}], commands: [], errors: [] }),
    discover: async () => [{ path: candidate.path }],
    fingerprint: async () => [candidate],
    withSchemaDirectory: async (callback) => callback("C:\\schema"),
    generateSchema: async () => ({
      version: candidate.version,
      executionDigest: candidate.executionDigest,
      nativeSha256: candidate.nativeSha256,
      schemaSet: { rawSha256: "d".repeat(64), semanticSha256: "e".repeat(64), files: [] },
      sourceKinds: ["cli"],
    }),
    readSourceKinds: async () => ["cli"],
    probeIdentity: async () => ({ initialized: true }),
    probeDispatch: async () => ({ status: "pass" }),
    prepareFixture: async (value) => {
      assert.equal(value, fixture);
      return canonicalFixture;
    },
    confirmDesktop,
    displayApproval,
    runLive: async (...args) => {
      liveCall = args;
      return {
        quota: { persistentThreads: 1, modelTurns: 2, approvals: "decline-only" },
        marker: { threadId: "thread-marker", marker: "[Projectboard Phase 0] fixed" },
        appServerIdentity: { status: "pass" },
        approvalLifecycle: { status: "pass" },
        doubleWriteControl: { status: "pass" },
      };
    },
  });
  const report = await runPhase0(options, probes);
  assert.equal(liveCall[0], candidate);
  assert.deepEqual(liveCall[1], ["cli"]);
  assert.equal(liveCall[2], canonicalFixture);
  assert.equal(liveCall[3], confirmDesktop);
  assert.deepEqual(liveCall[4].consent, {
    allowPersistentThread: true,
    allowModelTurns: true,
  });
  assert.equal(liveCall[4].displayApproval, displayApproval);
  const identityEvidence = report.gates.find(({ id }) => id === "app_server_identity").evidence[0];
  assert.deepEqual(identityEvidence.liveIdentity, {
    quota: { persistentThreads: 1, modelTurns: 2, approvals: "decline-only" },
    marker: { threadId: "thread-marker", marker: "[Projectboard Phase 0] fixed" },
    appServerIdentity: { status: "pass" },
  });
  assert.equal(report.gates.find(({ id }) => id === "approval_lifecycle").status, "pass");
  assert.equal(report.gates.find(({ id }) => id === "double_write_control").status, "pass");
});

test("one live-suite failure is preserved by both dependent gates without rerunning it", async () => {
  const candidate = {
    path: "C:\\Codex\\codex.exe",
    canonicalPath: "C:\\Codex\\codex.exe",
    origin: "package",
    viable: true,
    version: "codex-cli 1.0.0",
    launcherSha256: "a".repeat(64),
    nativeSha256: "b".repeat(64),
    executionDigest: "c".repeat(64),
    launchRecipe: { kind: "private-staged-snapshot" },
  };
  const fixture = path.resolve("fixtures", "phase-0-live-failure");
  const options = {
    ...parseArguments([
      "live",
      "--allow-persistent-thread",
      "--allow-model-turns",
      "--fixture-cwd",
      fixture,
    ]),
    runId: "live-failure",
  };
  let liveCalls = 0;
  let dispatchCalls = 0;
  const liveError = Object.assign(new Error("accepted turn interrupt failed"), { code: "ELIVEINTERRUPT" });
  const probes = createDefaultProbes(options, {
    collectInventory: async () => ({ package: {}, startApps: [{}], commands: [], errors: [] }),
    discover: async () => [{ path: candidate.path }],
    fingerprint: async () => [candidate],
    withSchemaDirectory: async (callback) => callback("C:\\schema"),
    generateSchema: async () => ({
      version: candidate.version,
      executionDigest: candidate.executionDigest,
      nativeSha256: candidate.nativeSha256,
      schemaSet: { rawSha256: "d".repeat(64), semanticSha256: "e".repeat(64), files: [] },
      sourceKinds: ["cli"],
    }),
    readSourceKinds: async () => ["cli"],
    probeIdentity: async () => ({ initialized: true }),
    prepareFixture: async () => fixture,
    runLive: async () => { liveCalls += 1; throw liveError; },
    probeDispatch: async () => { dispatchCalls += 1; return { status: "pass" }; },
  });
  const report = await runPhase0(options, probes);
  const appGate = report.gates.find(({ id }) => id === "app_server_identity");
  assert.equal(appGate.status, "fail");
  assert.equal(appGate.evidence[0].selected.path, candidate.path);
  assert.equal(appGate.evidence[0].schema.executionDigest, candidate.executionDigest);
  assert.equal(appGate.evidence[0].identity.initialized, true);
  assert.equal(appGate.evidence[0].liveFailure.code, "ELIVEINTERRUPT");
  for (const id of ["approval_lifecycle", "double_write_control"]) {
    const gate = report.gates.find((candidateGate) => candidateGate.id === id);
    assert.equal(gate.status, "fail");
    assert.match(gate.notes[0], /accepted turn interrupt failed/u);
    assert.equal(gate.evidence[0].code, "ELIVEINTERRUPT");
  }
  assert.equal(liveCalls, 1);
  assert.equal(dispatchCalls, 1);
});

test("owned schema workspace remains until a generator child settles and deferred cleanup completes", async () => {
  let workspace = null;
  let settleGenerator;
  const generatorCleanup = new Promise((resolve) => { settleGenerator = resolve; });
  const generatorError = Object.assign(new Error("schema child is unsettled"), {
    code: "ECHILDUNSETTLED",
    unsettled: true,
    cleanup: { attempted: false, deferred: true, retained: true, ok: false },
    deferredCleanup: generatorCleanup,
  });
  const rejected = await withOwnedSchemaDirectory(async (schemaDirectory) => {
    workspace = path.dirname(schemaDirectory);
    await mkdir(schemaDirectory);
    throw generatorError;
  }).catch((error) => error);
  assert.equal(rejected, generatorError);
  assert.equal(rejected.outerCleanup.deferred, true);
  assert.equal(rejected.outerCleanup.retained, true);
  await access(workspace);

  settleGenerator({
    settlement: { unsettled: false, code: 0, signal: null, error: null },
    cleanup: { attempted: true, ok: true, retained: false, error: null },
  });
  const deferred = await rejected.deferredCleanup;
  assert.equal(deferred.outerCleanup.ok, true);
  await assert.rejects(() => access(workspace), /ENOENT/u);
});

test("main publishes one timestamped report through injected orchestration", async () => {
  const reportRoot = path.resolve("artifacts-test-root");
  let observedOptions = null;
  let observedDirectory = null;
  const report = {
    schemaVersion: 1,
    runId: "fixed-run",
    options: {},
    gates: [],
    phases: { phase2: "no-go" },
    redactions: [],
  };
  const result = await main(["readonly"], {
    randomUUID: () => "fixed-run",
    now: () => new Date("2026-08-10T01:02:03.000Z"),
    reportRoot,
    probes: {},
    runPhase0: async (options, probes) => {
      observedOptions = options;
      assert.deepEqual(probes, {});
      return report;
    },
    writeReport: async (directory, value) => {
      observedDirectory = directory;
      assert.equal(value, report);
      return { directory };
    },
  });
  assert.equal(observedOptions.mode, "readonly");
  assert.equal(observedOptions.runId, "fixed-run");
  assert.equal(observedOptions.observedAt, "2026-08-10T01:02:03.000Z");
  assert.equal(
    observedDirectory,
    path.join(reportRoot, "2026-08-10T01-02-03.000Z-fixed-run"),
  );
  assert.equal(result.reportDirectory, observedDirectory);
  assert.deepEqual(result.phases, { phase2: "no-go" });
});
