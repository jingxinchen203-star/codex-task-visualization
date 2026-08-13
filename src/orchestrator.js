import { GATE_IDS, evaluatePhases } from "./report/model.js";

const VALID_STATUSES = new Set(["pass", "fail", "inconclusive", "skipped"]);
const STRUCTURED_ERROR_FIELDS = Object.freeze([
  "name", "code", "message",
  "errors", "cause", "turnId", "threadId", "requestId", "itemId",
  "lifecycle", "closeError", "interruptError", "cleanup", "cleanupErrors", "outerCleanup",
  "terminationError", "settlementError", "cleanupError", "stderrError",
  "settlement", "disposal", "termination", "stderr", "forcedTermination", "child", "generator", "error",
  "status", "decision", "settled", "unsettled", "signal", "attempted", "deferred", "retained", "ok",
  "cleanupOk", "cleanupDeferred", "cleanupRetained", "terminationGraceExpired",
  "stderrBytes", "stderrTruncated", "truncated", "bytes", "requested", "accepted", "replayed",
  "deferredCleanup",
]);
const MAX_ERROR_DEPTH = 6;
const MAX_ERROR_ITEMS = 16;
const MAX_ERROR_TEXT = 4_096;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function boundedText(value) {
  const text = typeof value === "string" ? value : String(value);
  return text.length <= MAX_ERROR_TEXT ? text : `${text.slice(0, MAX_ERROR_TEXT)}…`;
}

function structuredFailureValue(value, depth, seen) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return boundedText(value);
  if (depth >= MAX_ERROR_DEPTH) return Object.freeze({ truncated: true });
  if (seen.has(value)) return Object.freeze({ cycle: true });
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      return Object.freeze(value.slice(0, MAX_ERROR_ITEMS).map((entry) => (
        structuredFailureValue(entry, depth + 1, seen)
      )));
    } finally {
      seen.delete(value);
    }
  }
  seen.add(value);
  try {
    const output = {};
    if (value instanceof Error) {
      output.name = typeof value.name === "string" ? boundedText(value.name) : "Error";
      output.code = typeof value.code === "string" || Number.isInteger(value.code) ? value.code : null;
      output.message = typeof value.message === "string" ? boundedText(value.message) : "Unknown error";
    }
    for (const field of STRUCTURED_ERROR_FIELDS) {
      if (field === "deferredCleanup") {
        if (value[field]?.then) output[field] = true;
        else if (typeof value[field] === "boolean") output[field] = value[field];
        continue;
      }
      const fieldValue = value[field];
      if (fieldValue === undefined) continue;
      output[field] = structuredFailureValue(fieldValue, depth + 1, seen);
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
}

function safeFailure(error) {
  try {
    const structured = error && typeof error === "object"
      ? structuredFailureValue(error, 0, new Set())
      : {};
    return Object.freeze({
      ...structured,
      name: typeof structured.name === "string" && structured.name.length > 0 ? structured.name : "Error",
      code: typeof structured.code === "string" || Number.isInteger(structured.code) ? structured.code : null,
      message: typeof structured.message === "string" && structured.message.length > 0
        ? structured.message
        : (error && typeof error === "object"
          ? "Probe failed without an error message"
          : boundedText(error)),
    });
  } catch {
    return Object.freeze({
      name: "Error",
      code: "EUNREADABLEFAILURE",
      message: "Probe failed with unreadable structured error evidence",
    });
  }
}

function resultGate(id, value) {
  requireObject(value, `${id} probe result`);
  const status = value.status ?? "pass";
  if (!VALID_STATUSES.has(status)) throw new Error(`invalid probe status for ${id}`);
  const notes = value.notes ?? [];
  if (!Array.isArray(notes) || notes.some((note) => typeof note !== "string")) {
    throw new TypeError(`${id} probe notes must be strings`);
  }
  return Object.freeze({
    id,
    status,
    evidence: Object.freeze([value]),
    notes: Object.freeze([...notes]),
  });
}

export async function runPhase0(options, probes) {
  requireObject(options, "options");
  requireObject(probes, "probes");
  const gates = [];
  const context = { options };

  for (const id of GATE_IDS) {
    const probe = probes[id];
    if (probe === undefined) {
      gates.push(Object.freeze({
        id,
        status: "skipped",
        evidence: Object.freeze([]),
        notes: Object.freeze(["probe not enabled"]),
      }));
      continue;
    }
    if (typeof probe !== "function") {
      gates.push(Object.freeze({
        id,
        status: "fail",
        evidence: Object.freeze([]),
        notes: Object.freeze(["probe is not callable"]),
      }));
      continue;
    }
    try {
      const value = await probe(context);
      const gate = resultGate(id, value);
      context[id] = value;
      gates.push(gate);
    } catch (error) {
      const failure = safeFailure(error);
      gates.push(Object.freeze({
        id,
        status: "fail",
        evidence: Object.freeze([failure]),
        notes: Object.freeze([failure.message]),
      }));
    }
  }

  const phases = evaluatePhases(gates);
  return Object.freeze({
    schemaVersion: 1,
    runId: typeof options.runId === "string" ? options.runId : null,
    options: Object.freeze({ ...options }),
    gates: Object.freeze(gates),
    phases: Object.freeze({ ...phases }),
    redactions: Object.freeze([
      "authorization",
      "bearer",
      "token",
      "nonce",
      "prompt",
      "full-thread-content",
    ]),
  });
}
