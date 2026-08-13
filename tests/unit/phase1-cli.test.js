import test from "node:test";
import assert from "node:assert/strict";
import { main, parseArguments } from "../../src/phase-1/cli.js";

test("Phase 1 CLI accepts only read selection flags and has no injection or mutation mode", () => {
  assert.deepEqual(parseArguments([]), {
    phase0Report: null,
    phase0Root: "artifacts\\phase-0",
    check: false,
  });
  assert.deepEqual(parseArguments(["--phase0-report", "C:\\evidence\\report.json"]), {
    phase0Report: "C:\\evidence\\report.json",
    phase0Root: "artifacts\\phase-0",
    check: false,
  });
  assert.deepEqual(parseArguments(["--phase0-root", "C:\\evidence"]), {
    phase0Report: null,
    phase0Root: "C:\\evidence",
    check: false,
  });
  for (const forbidden of ["--allow-model-turns", "--allow-codex-restart", "--probe-existing-instance", "--inject", "--write"]) {
    assert.throws(() => parseArguments([forbidden]), /unknown argument/u);
  }
  assert.throws(() => parseArguments(["--phase0-report"]), /requires a value/u);
  assert.throws(() => parseArguments(["--check", "--check"]), /duplicate argument/u);
  assert.throws(() => parseArguments(["--phase0-report", "a", "--phase0-root", "b"]), /mutually exclusive/u);
});

test("Phase 1 CLI check mode reads one snapshot without starting a server", async () => {
  assert.deepEqual(parseArguments(["--check"]), {
    phase0Report: null,
    phase0Root: "artifacts\\phase-0",
    check: true,
  });
  let starts = 0;
  const result = await main(["--check"], {
    prepare: async () => ({ mode: "standalone-readonly", summary: { taskCount: 2 } }),
    startServer: async () => { starts += 1; },
  });
  assert.equal(result.server, null);
  assert.equal(result.snapshot.summary.taskCount, 2);
  assert.equal(starts, 0);
});

test("Phase 1 CLI prepares one snapshot and starts one standalone server", async () => {
  const snapshot = Object.freeze({
    mode: "standalone-readonly",
    summary: Object.freeze({ taskCount: 3, projectCount: 2 }),
  });
  const server = Object.freeze({
    url: "http://127.0.0.1:1234/#secret",
    close: async () => {},
  });
  const calls = [];
  const result = await main(["--phase0-root", "custom"], {
    prepare: async (options) => { calls.push(["prepare", options]); return snapshot; },
    startServer: async (options) => { calls.push(["server", options]); return server; },
  });
  assert.deepEqual(calls, [
    ["prepare", { phase0Report: null, phase0Root: "custom" }],
    ["server", { snapshot }],
  ]);
  assert.deepEqual(result, { snapshot, server });
});
