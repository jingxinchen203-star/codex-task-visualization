import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

export const LOCAL_BOARD_LANES = Object.freeze(["inbox", "planned", "running", "review", "done"]);
const LANE_SET = new Set(LOCAL_BOARD_LANES);
const MAX_OVERRIDE_COUNT = 10_000;
const MAX_FILE_BYTES = 512 * 1024;

function validateThreadId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\0-\x1f\x7f]/u.test(value)) {
    throw new TypeError("threadId must be a bounded nonempty string without control characters");
  }
  return value;
}

function validateLaneId(value) {
  if (!LANE_SET.has(value)) throw new TypeError("laneId must be one of the canonical five lanes");
  return value;
}

export function validateLaneOverrides(value) {
  if (!Array.isArray(value) || value.length > MAX_OVERRIDE_COUNT) {
    throw new TypeError("lane overrides must be a bounded array");
  }
  const seen = new Set();
  return Object.freeze(value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("each lane override must be an object");
    }
    const threadId = validateThreadId(entry.threadId);
    const laneId = validateLaneId(entry.laneId);
    if (seen.has(threadId)) throw new TypeError("lane overrides must contain unique thread IDs");
    seen.add(threadId);
    return Object.freeze({ threadId, laneId });
  }));
}

export function upsertLaneOverride(overrides, move) {
  const current = validateLaneOverrides(overrides);
  const threadId = validateThreadId(move?.threadId);
  const laneId = validateLaneId(move?.laneId);
  return validateLaneOverrides([
    ...current.filter((entry) => entry.threadId !== threadId),
    { threadId, laneId },
  ].sort((left, right) => left.threadId.localeCompare(right.threadId, "en")));
}

export function defaultLaneOverridePath({ localAppData = process.env.LOCALAPPDATA } = {}) {
  const base = typeof localAppData === "string" && localAppData.length > 0
    ? localAppData
    : join(homedir(), "AppData", "Local");
  return join(base, "CodexProjectboard", "lane-overrides.v1.json");
}

export async function loadLaneOverrides(filePath, { read = readFile } = {}) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
    throw new TypeError("lane override file path must be a nonempty path");
  }
  let contents;
  try {
    contents = await read(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), "utf8");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("lane override file exceeds the size limit");
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("lane override file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || parsed.schemaVersion !== 1 || !Array.isArray(parsed.overrides)) {
    throw new Error("lane override file has an unsupported schema");
  }
  return validateLaneOverrides(parsed.overrides);
}

export async function persistLaneOverrides(filePath, overrides, {
  makeDirectory = mkdir,
  write = writeFile,
  replace = rename,
  remove = unlink,
  uniqueId = randomUUID,
} = {}) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
    throw new TypeError("lane override file path must be a nonempty path");
  }
  const validated = validateLaneOverrides(overrides);
  const parent = dirname(filePath);
  const temporary = join(parent, `.lane-overrides-${uniqueId()}.tmp`);
  const document = `${JSON.stringify({ schemaVersion: 1, overrides: validated }, null, 2)}\n`;
  await makeDirectory(parent, { recursive: true });
  try {
    await write(temporary, document, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await replace(temporary, filePath);
  } catch (error) {
    try {
      await remove(temporary);
    } catch {
      // Preserve the primary write failure.
    }
    throw error;
  }
  return validated;
}
