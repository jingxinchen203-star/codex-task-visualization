import { lstat, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  OperationGuard,
  classifyExecutionPath,
  createOwnedDirectory,
  ensureLocalDirectory,
  identityOf,
  safeRemoveOwnedDirectory,
  verifyOwnedDirectory,
} from "../process/security-policy.js";

const REDACTED_KEY = /authorization|bearer|token|nonce|prompt|full.*thread|thread.*(?:body|content)|secret|credential|password|cookie|api.?key|private.?key|access.?key/iu;
const THREAD_CONTENT_KEY = /^(?:body|content|messages?|input|prompt|text)$/iu;
const BEARER_VALUE = /\bBearer\s+[^\s"']+/giu;
const API_KEY_VALUE = /\bsk-[A-Za-z0-9_-]{8,}/gu;

function sanitizeString(value) {
  return value.replace(BEARER_VALUE, "Bearer [REDACTED]").replace(API_KEY_VALUE, "[REDACTED]");
}

function redactedPath(pathSegments) {
  const key = pathSegments.at(-1) ?? "";
  if (REDACTED_KEY.test(key)) return true;
  return THREAD_CONTENT_KEY.test(key)
    && pathSegments.slice(0, -1).some((segment) => /^threads?$/iu.test(segment));
}

function sanitize(value, pathSegments = [], seen = new Set()) {
  if (redactedPath(pathSegments)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? sanitizeString(value) : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("report contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("report contains a non-serializable value");
  if (seen.has(value)) throw new TypeError("report contains a cycle and cannot be serialized");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => sanitize(entry, [...pathSegments, String(index)], seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("report contains a non-plain object");
    }
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [
      name,
      sanitize(entry, [...pathSegments, name], seen),
    ]));
  } finally {
    seen.delete(value);
  }
}

function markdownCell(value) {
  return sanitizeString(String(value ?? "")).replaceAll("|", "\\|").replace(/[\r\n]+/gu, " ");
}

function renderSummary(report) {
  const rows = report.gates.map((gate) => (
    `| ${markdownCell(gate.id)} | ${markdownCell(gate.status)} | ${markdownCell((gate.notes ?? []).join("; "))} |`
  )).join("\n");
  return `# Phase 0 Compatibility Report\n\nRun: ${markdownCell(report.runId)}\n\n`
    + "| Gate | Status | Notes |\n|---|---|---|\n"
    + `${rows}\n`;
}

function requireReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new TypeError("report must be an object");
  if (typeof report.runId !== "string" || report.runId.length === 0) throw new TypeError("report.runId is required");
  if (!Array.isArray(report.gates)) throw new TypeError("report.gates must be an array");
}

async function requireAbsent(destination, guard) {
  guard.check();
  try {
    await guard.race(lstat(destination));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw Object.assign(new Error(`Refusing to replace an existing or sealed report: ${destination}`), {
    code: "EREPORTEXISTS",
  });
}

async function destinationOwnsPublishedDirectory(destination, owned) {
  try {
    const stats = await lstat(destination, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    const identity = identityOf(stats);
    return identity.dev === owned.identity.dev && identity.ino === owned.identity.ino;
  } catch {
    return false;
  }
}

export async function writeReport(directory, report, {
  timeoutMs = 30_000,
  writeFileImpl = writeFile,
  renameImpl = rename,
} = {}) {
  if (typeof directory !== "string" || directory.length === 0 || !path.isAbsolute(directory)) {
    throw new TypeError("report directory must be an absolute local path");
  }
  classifyExecutionPath(directory);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
  if (typeof writeFileImpl !== "function" || typeof renameImpl !== "function") {
    throw new TypeError("writeFileImpl and renameImpl must be functions");
  }
  requireReport(report);
  const safeReport = sanitize(report);
  const reportJson = `${JSON.stringify(safeReport, null, 2)}\n`;
  const summary = renderSummary(safeReport);
  const guard = new OperationGuard({ timeoutMs });
  let temporaryOwned = null;
  let published = false;
  try {
    const lexicalDestination = path.resolve(directory);
    const parent = await ensureLocalDirectory(path.dirname(lexicalDestination), guard);
    const destination = path.join(parent.canonicalPath, path.basename(lexicalDestination));
    await requireAbsent(destination, guard);
    temporaryOwned = await createOwnedDirectory(
      parent.canonicalPath,
      `.${path.basename(destination)}.report-tmp-`,
      guard,
    );
    const temporary = temporaryOwned.canonicalPath;
    await verifyOwnedDirectory(temporaryOwned, guard);
    guard.check();
    await writeFileImpl(path.join(temporary, "report.json"), reportJson, { encoding: "utf8", flag: "wx" });
    guard.check();
    await verifyOwnedDirectory(temporaryOwned, guard);
    guard.check();
    await writeFileImpl(path.join(temporary, "summary.md"), summary, { encoding: "utf8", flag: "wx" });
    guard.check();
    await verifyOwnedDirectory(temporaryOwned, guard);
    guard.check();
    await writeFileImpl(path.join(temporary, ".report-sealed"), `${safeReport.runId}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    guard.check();
    await verifyOwnedDirectory(temporaryOwned, guard);
    await requireAbsent(destination, guard);
    guard.check();
    try {
      await renameImpl(temporary, destination);
      published = true;
    } catch (renameError) {
      if (await destinationOwnsPublishedDirectory(destination, temporaryOwned)) published = true;
      else throw renameError;
    }
    return Object.freeze({
      directory: destination,
      reportPath: path.join(destination, "report.json"),
      summaryPath: path.join(destination, "summary.md"),
    });
  } catch (error) {
    if (temporaryOwned && !published) error.cleanup = await safeRemoveOwnedDirectory(temporaryOwned);
    throw error;
  } finally {
    guard.dispose();
  }
}
