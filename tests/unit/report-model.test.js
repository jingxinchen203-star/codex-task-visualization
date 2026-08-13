import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePhases, GATE_IDS } from "../../src/report/model.js";

const result = (id, status) => ({ id, status, evidence: [], notes: [] });

test("read-only remains viable when injection is no-go", () => {
  const gates = GATE_IDS.map((id) => result(id, "pass"));
  gates.find((gate) => gate.id === "secure_injection").status = "fail";
  assert.deepEqual(evaluatePhases(gates), {
    standalonePhase1: "go",
    injectedPhase1: "no-go",
    phase2: "no-go",
    phase3: "blocked-by-git-gate",
  });
});

test("App Server identity failure blocks execution", () => {
  const gates = GATE_IDS.map((id) => result(id, "pass"));
  gates.find((gate) => gate.id === "app_server_identity").status = "fail";
  assert.equal(evaluatePhases(gates).standalonePhase1, "go-with-readonly-degradation");
  assert.equal(evaluatePhases(gates).phase2, "no-go");
});
