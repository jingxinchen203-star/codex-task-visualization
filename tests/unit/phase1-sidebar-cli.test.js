import test from "node:test";
import assert from "node:assert/strict";
import { main, parseSidebarArguments } from "../../src/phase-1/sidebar-cli.js";

test("sidebar CLI accepts only Phase 0 lock selection and exposes no port or mutation flags", () => {
  assert.deepEqual(parseSidebarArguments([]), {
    phase0Report: null,
    phase0Root: "artifacts\\phase-0",
  });
  assert.deepEqual(parseSidebarArguments(["--phase0-report", "C:\\evidence\\report.json"]), {
    phase0Report: "C:\\evidence\\report.json",
    phase0Root: "artifacts\\phase-0",
  });
  for (const forbidden of [
    "--remote-debugging-port",
    "--user-data-dir",
    "--allow-model-turns",
    "--inject-existing",
    "--write",
  ]) assert.throws(() => parseSidebarArguments([forbidden]), /unknown argument/u);
});

test("sidebar CLI resolves one bound package and delegates the fixed controller input", async () => {
  const calls = [];
  const lock = { candidate: { path: "locked" }, sourceKinds: ["old"] };
  const binding = {
    candidate: { path: "current" },
    sourceKinds: ["vscode", "appServer"],
    continuity: "same-package-upgrade-readonly",
  };
  const controller = { initialSnapshot: { summary: {} } };
  const result = await main(["--phase0-root", "custom"], {
    findLock: async (root) => { calls.push(["find", root]); return lock; },
    loadLock: async () => { throw new Error("unexpected load"); },
    bindCandidate: async (value) => { calls.push(["bind", value]); return binding; },
    validateExecutable: async (candidate) => { calls.push(["executable", candidate]); return "C:\\Package\\ChatGPT.exe"; },
    startController: async (options) => { calls.push(["start", options]); return controller; },
    resolveLaneOverridePath: () => "C:\\state\\lane-overrides.v1.json",
  });
  assert.equal(result, controller);
  assert.deepEqual(calls, [
    ["find", "custom"],
    ["bind", lock],
    ["executable", binding.candidate],
    ["start", {
      executable: "C:\\Package\\ChatGPT.exe",
      lock,
      binding,
      sourceKinds: [],
      laneOverridePath: "C:\\state\\lane-overrides.v1.json",
    }],
  ]);
});
