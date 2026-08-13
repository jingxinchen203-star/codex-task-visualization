import test from "node:test";
import assert from "node:assert/strict";
import { classifyExecutionPath } from "../../src/process/run-command.js";

test("UNC and device paths are rejected without filesystem access", () => {
  assert.throws(() => classifyExecutionPath("\\\\server\\share\\codex.exe"), { code: "ENETWORKPATH" });
  assert.throws(() => classifyExecutionPath("\\\\?\\UNC\\server\\share\\codex.exe"), { code: "ENETWORKPATH" });
  assert.throws(() => classifyExecutionPath("\\\\.\\pipe\\codex"), { code: "ENETWORKPATH" });
  assert.equal(classifyExecutionPath("C:\\Tools\\codex.exe"), "local");
});
