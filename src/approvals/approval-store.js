import { createHash } from "node:crypto";

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireText(value, code, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw codedError(code, `${label} must be a nonempty string`);
  }
  return value;
}

function optionalText(value, code, label) {
  if (value === undefined || value === null) return null;
  return requireText(value, code, label);
}

function normalizeRequestId(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (Number.isSafeInteger(value)) return String(value);
  throw codedError("EAPPROVALREQUEST", "requestId must be a nonempty string or safe integer");
}

function canonicalJson(value, seen = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw codedError("EAPPROVALREQUEST", "approval identity must contain finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw codedError("EAPPROVALREQUEST", "approval identity must be JSON serializable");
  }
  if (seen.has(value)) throw codedError("EAPPROVALREQUEST", "approval identity must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw codedError("EAPPROVALREQUEST", "approval identity arrays must not be sparse");
        }
      }
      return `[${value.map((entry) => canonicalJson(entry, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw codedError("EAPPROVALREQUEST", "approval identity objects must be plain JSON objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw codedError("EAPPROVALREQUEST", "approval identity objects must not contain symbol keys");
    }
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`
    )).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function approvalIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("EAPPROVALREQUEST", "approval request must be an object");
  }
  const instanceId = requireText(value.instanceId, "EAPPROVALREQUEST", "instanceId");
  const requestId = normalizeRequestId(value.requestId);
  const requestMethod = requireText(value.requestMethod, "EAPPROVALREQUEST", "requestMethod");
  const scope = value.scope;
  if (scope !== undefined && scope !== null) {
    const prototype = typeof scope === "object" && !Array.isArray(scope)
      ? Object.getPrototypeOf(scope)
      : undefined;
    if (prototype !== Object.prototype && prototype !== null) {
      throw codedError("EAPPROVALREQUEST", "scope must be a plain JSON object");
    }
    const allowedScopeKeys = new Set(["network", "additionalPermissions", "grantRoot"]);
    if (Reflect.ownKeys(scope).some((key) => typeof key !== "string" || !allowedScopeKeys.has(key))) {
      throw codedError("EAPPROVALREQUEST", "scope contains an unsupported permission field");
    }
  }
  const scoped = (key) => scope?.[key] ?? value[key] ?? null;
  return {
    instanceId,
    requestId,
    requestMethod,
    threadId: optionalText(value.threadId, "EAPPROVALREQUEST", "threadId"),
    turnId: optionalText(value.turnId, "EAPPROVALREQUEST", "turnId"),
    itemId: optionalText(value.itemId, "EAPPROVALREQUEST", "itemId"),
    command: optionalText(value.command, "EAPPROVALREQUEST", "command"),
    cwd: optionalText(value.cwd, "EAPPROVALREQUEST", "cwd"),
    network: scoped("network"),
    additionalPermissions: scoped("additionalPermissions"),
    grantRoot: scoped("grantRoot"),
  };
}

export function digestApproval(value) {
  return createHash("sha256").update(canonicalJson(approvalIdentity(value))).digest("hex");
}

function publicRow(row) {
  if (!row) return null;
  return Object.freeze({
    instanceId: row.instance_id,
    requestId: row.request_id,
    digest: row.digest,
    expiresAt: Number(row.expires_at),
    status: row.status,
    decision: row.decision,
    responder: row.responder,
    respondedAt: row.responded_at === null ? null : Number(row.responded_at),
  });
}

export class ApprovalStore {
  constructor(database, now = Date.now) {
    if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
      throw new TypeError("database must be a node:sqlite DatabaseSync-compatible object");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.database = database;
    this.now = now;
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS approvals (
        instance_id TEXT NOT NULL CHECK(length(instance_id) > 0),
        request_id TEXT NOT NULL CHECK(length(request_id) > 0),
        digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
        payload TEXT NOT NULL CHECK(json_valid(payload)),
        expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at >= 0),
        status TEXT NOT NULL CHECK(status IN ('pending', 'denied', 'approved', 'expired')),
        decision TEXT CHECK(decision IN ('decline', 'accept')),
        responder TEXT CHECK(responder = 'human-ui'),
        responded_at INTEGER CHECK(
          responded_at IS NULL OR (typeof(responded_at) = 'integer' AND responded_at >= 0)
        ),
        PRIMARY KEY(instance_id, request_id),
        CHECK(
          (status = 'pending' AND decision IS NULL AND responder IS NULL AND responded_at IS NULL)
          OR (status = 'expired' AND decision IS NULL AND responder IS NULL AND responded_at IS NULL)
          OR (status = 'denied' AND decision = 'decline' AND responder = 'human-ui' AND responded_at IS NOT NULL)
          OR (status = 'approved' AND decision = 'accept' AND responder = 'human-ui' AND responded_at IS NOT NULL)
        )
      );
    `);
    this._insert = database.prepare(`
      INSERT INTO approvals(instance_id, request_id, digest, payload, expires_at, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
      ON CONFLICT(instance_id, request_id) DO NOTHING
    `);
    this._select = database.prepare(`
      SELECT instance_id, request_id, digest, payload, expires_at, status,
             decision, responder, responded_at
      FROM approvals WHERE instance_id = ? AND request_id = ?
    `);
    this._requestCollision = database.prepare(`
      SELECT 1 AS present FROM approvals WHERE request_id = ? LIMIT 1
    `);
    this._expire = database.prepare(`
      UPDATE approvals SET status = 'expired'
      WHERE instance_id = ? AND request_id = ? AND status = 'pending'
    `);
    this._respond = database.prepare(`
      UPDATE approvals
      SET status = ?, decision = ?, responder = 'human-ui', responded_at = ?
      WHERE instance_id = ? AND request_id = ? AND status = 'pending' AND digest = ?
    `);
  }

  _time() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw codedError("EAPPROVALCLOCK", "approval clock must return a nonnegative safe integer");
    }
    return value;
  }

  _immediate(action) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve the original transition error */ }
      throw error;
    }
  }

  add(request, expiresAt) {
    const identity = approvalIdentity(request);
    if (!Number.isSafeInteger(expiresAt)) {
      throw codedError("EAPPROVALEXPIRY", "approval expiry must be a future safe integer deadline");
    }
    const payload = canonicalJson(identity);
    const digest = createHash("sha256").update(payload).digest("hex");
    return this._immediate(() => {
      if (expiresAt <= this._time()) {
        throw codedError("EAPPROVALEXPIRY", "approval expiry must be a future safe integer deadline");
      }
      if (this._insert.run(identity.instanceId, identity.requestId, digest, payload, expiresAt).changes === 1) {
        return true;
      }
      const existing = this._select.get(identity.instanceId, identity.requestId);
      if (existing?.digest === digest && existing.payload === payload && Number(existing.expires_at) === expiresAt) {
        return false;
      }
      throw codedError("EAPPROVALCONFLICT", "approval identity already belongs to a different request");
    });
  }

  respond({ requestId, responder, instanceId, digest, decision } = {}) {
    if (responder !== "human-ui") throw codedError("ERESPONDER", "only human-ui may respond to approvals");
    if (decision !== "decline" && decision !== "accept") {
      throw codedError("EAPPROVALDECISION", "invalid approval decision");
    }
    requireText(instanceId, "EAPPROVALIDENTITY", "instanceId");
    const normalizedRequestId = normalizeRequestId(requestId);
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw codedError("EAPPROVALIDENTITY", "approval identity changed");
    }
    const outcome = this._immediate(() => {
      const row = this._select.get(instanceId, normalizedRequestId);
      if (!row) {
        const collision = this._requestCollision.get(normalizedRequestId);
        throw codedError(
          collision ? "EAPPROVALIDENTITY" : "EAPPROVALNOTFOUND",
          collision ? "approval identity changed" : "approval is not pending",
        );
      }
      if (row.digest !== digest) throw codedError("EAPPROVALIDENTITY", "approval identity changed");
      if (row.status === "expired") {
        throw codedError("EAPPROVALEXPIRED", "approval expired");
      }
      if (row.status === "approved" || row.status === "denied") {
        if (row.decision === decision && row.responder === responder) {
          return { requestId, decision, replayed: true };
        }
        throw codedError("EAPPROVALSETTLED", "approval already has a different decision");
      }
      const now = this._time();
      if (now >= Number(row.expires_at)) {
        if (this._expire.run(instanceId, normalizedRequestId).changes !== 1) {
          throw codedError("EAPPROVALRACE", "approval expiry transition raced");
        }
        return { error: codedError("EAPPROVALEXPIRED", "approval expired") };
      }
      const status = decision === "decline" ? "denied" : "approved";
      const updated = this._respond.run(
        status,
        decision,
        now,
        instanceId,
        normalizedRequestId,
        digest,
      );
      if (updated.changes !== 1) throw codedError("EAPPROVALRACE", "approval response raced");
      return { requestId, decision, replayed: false };
    });
    if (outcome.error) throw outcome.error;
    return Object.freeze(outcome);
  }

  get(instanceId, requestId) {
    requireText(instanceId, "EAPPROVALIDENTITY", "instanceId");
    const normalizedRequestId = normalizeRequestId(requestId);
    const observed = this._select.get(instanceId, normalizedRequestId);
    if (!observed || observed.status !== "pending") return publicRow(observed);
    return publicRow(this._immediate(() => {
      const current = this._select.get(instanceId, normalizedRequestId);
      if (current?.status === "pending" && this._time() >= Number(current.expires_at)) {
        if (this._expire.run(instanceId, normalizedRequestId).changes !== 1) {
          throw codedError("EAPPROVALRACE", "approval expiry transition raced");
        }
        return this._select.get(instanceId, normalizedRequestId);
      }
      return current;
    }));
  }
}
