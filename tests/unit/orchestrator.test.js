import test from "node:test";
import assert from "node:assert/strict";
import { GATE_IDS } from "../../src/report/model.js";
import { runPhase0 } from "../../src/orchestrator.js";

test("one failed probe does not erase later evidence", async () => {
  const calls = [];
  const probes = {
    windows_inventory: async () => { calls.push("windows_inventory"); return { count: 1 }; },
    app_server_identity: async () => { calls.push("app_server_identity"); throw new Error("mismatch"); },
    local_api_security: async () => { calls.push("local_api_security"); return { status: "pass" }; },
    dispatch_recovery: async () => { calls.push("dispatch_recovery"); return { status: "pass" }; },
  };
  const report = await runPhase0({ mode: "readonly", runId: "run-1" }, probes);
  assert.deepEqual(calls, [
    "windows_inventory",
    "app_server_identity",
    "dispatch_recovery",
    "local_api_security",
  ]);
  assert.deepEqual(report.gates.map(({ id }) => id), GATE_IDS);
  assert.equal(report.gates.find(({ id }) => id === "app_server_identity").status, "fail");
  assert.equal(report.gates.find(({ id }) => id === "dispatch_recovery").status, "pass");
  assert.equal(report.gates.find(({ id }) => id === "secure_injection").status, "skipped");
  assert.equal(report.phases.phase2, "no-go");
});

test("probe context is sequential while invalid results fail closed", async () => {
  const probes = {
    windows_inventory: async () => ({ status: "pass", identity: "windows" }),
    secure_injection: async (context) => {
      assert.equal(context.windows_inventory.identity, "windows");
      return { status: "invented" };
    },
  };
  const report = await runPhase0({ mode: "readonly", runId: "run-2" }, probes);
  const injection = report.gates.find(({ id }) => id === "secure_injection");
  assert.equal(injection.status, "fail");
  assert.match(injection.notes[0], /invalid probe status/u);
  assert.equal(Object.hasOwn(injection, "stack"), false);
});

test("structured lifecycle and per-turn failure evidence is preserved without stacks or promises", async () => {
  const turnError = Object.assign(new Error("interrupt failed"), {
    code: "EINTERRUPT",
    turnId: "turn-a",
  });
  const cleanupError = Object.assign(new Error("close failed"), { code: "ELIVECLEANUP" });
  const failure = Object.assign(new AggregateError([turnError], "live failure"), {
    code: "ELIVEINTERRUPT",
    lifecycle: {
      settled: false,
      unsettled: true,
      cleanupDeferred: true,
      cleanupRetained: true,
    },
    cleanupErrors: [cleanupError],
    deferredCleanup: Promise.resolve({ cleanup: { ok: true } }),
  });
  const report = await runPhase0({ mode: "live", runId: "run-structured" }, {
    windows_inventory: async () => { throw failure; },
  });
  const evidence = report.gates[0].evidence[0];
  assert.equal(evidence.code, "ELIVEINTERRUPT");
  assert.equal(evidence.errors[0].code, "EINTERRUPT");
  assert.equal(evidence.errors[0].turnId, "turn-a");
  assert.equal(evidence.lifecycle.unsettled, true);
  assert.equal(evidence.lifecycle.cleanupDeferred, true);
  assert.equal(evidence.cleanupErrors[0].code, "ELIVECLEANUP");
  assert.equal(evidence.deferredCleanup, true);
  assert.equal(Object.hasOwn(evidence, "stack"), false);
  assert.equal(JSON.stringify(evidence).includes("Promise"), false);
});

test("plain-object rejections receive serializable fallback identity", async () => {
  const report = await runPhase0({ mode: "readonly", runId: "run-plain" }, {
    windows_inventory: async () => { throw { code: "EPLAIN" }; },
  });
  const gate = report.gates[0];
  assert.equal(gate.status, "fail");
  assert.equal(gate.evidence[0].name, "Error");
  assert.equal(gate.evidence[0].code, "EPLAIN");
  assert.equal(typeof gate.evidence[0].message, "string");
  assert.equal(typeof gate.notes[0], "string");
  assert.doesNotThrow(() => JSON.stringify(report));
});

test("hostile thrown accessors cannot stop later probes or report publication", async () => {
  const calls = [];
  const hostile = new Proxy({}, {
    get() { throw new Error("hostile getter"); },
  });
  const report = await runPhase0({ mode: "readonly", runId: "run-hostile" }, {
    windows_inventory: async () => { calls.push("windows"); throw hostile; },
    dispatch_recovery: async () => { calls.push("dispatch"); return { status: "pass" }; },
  });
  assert.deepEqual(calls, ["windows", "dispatch"]);
  const failure = report.gates[0].evidence[0];
  assert.equal(failure.code, "EUNREADABLEFAILURE");
  assert.equal(typeof failure.message, "string");
  assert.equal(report.gates.find(({ id }) => id === "dispatch_recovery").status, "pass");
  assert.doesNotThrow(() => JSON.stringify(report));
});
