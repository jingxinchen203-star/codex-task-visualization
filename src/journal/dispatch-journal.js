import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireText(value, code, label) {
  if (typeof value !== "string" || value.length === 0) throw codedError(code, `${label} must be a nonempty string`);
}

function publicRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    requestDigest: row.request_digest,
    fencingToken: Number(row.fencing_token),
    status: row.status,
    threadId: row.thread_id,
    turnId: row.turn_id,
  });
}

export class DispatchJournal {
  constructor(database) {
    if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
      throw new TypeError("database must be a node:sqlite DatabaseSync-compatible object");
    }
    this.database = database;
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS dispatch_journal (
        id TEXT PRIMARY KEY CHECK(length(id) > 0),
        request_digest TEXT NOT NULL CHECK(length(request_digest) > 0),
        fencing_token INTEGER NOT NULL CHECK(typeof(fencing_token) = 'integer' AND fencing_token > 0),
        status TEXT NOT NULL CHECK(status IN ('intent', 'sent', 'confirmed', 'unknown')),
        thread_id TEXT,
        turn_id TEXT,
        version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
        CHECK(
          (status = 'confirmed' AND length(thread_id) > 0 AND length(turn_id) > 0)
          OR
          (status <> 'confirmed' AND thread_id IS NULL AND turn_id IS NULL)
        )
      );
    `);
    this._insertIntent = database.prepare(`
      INSERT INTO dispatch_journal(id, request_digest, fencing_token, status)
      VALUES (?, ?, ?, 'intent')
      ON CONFLICT(id) DO NOTHING
    `);
    this._select = database.prepare(`
      SELECT id, request_digest, fencing_token, status, thread_id, turn_id, version
      FROM dispatch_journal WHERE id = ?
    `);
    this._markSent = database.prepare(`
      UPDATE dispatch_journal
      SET status = 'sent', version = version + 1
      WHERE id = ? AND status = 'intent'
    `);
    this._markConfirmed = database.prepare(`
      UPDATE dispatch_journal
      SET status = 'confirmed', thread_id = ?, turn_id = ?, version = version + 1
      WHERE id = ? AND status = 'sent'
    `);
    this._unresolved = database.prepare(`
      SELECT id FROM dispatch_journal
      WHERE status IN ('intent', 'sent')
      ORDER BY id
    `);
    this._markUnknown = database.prepare(`
      UPDATE dispatch_journal
      SET status = 'unknown', version = version + 1
      WHERE status IN ('intent', 'sent')
    `);
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

  createIntent({ id, requestDigest, fencingToken } = {}) {
    requireText(id, "EINTENT", "id");
    requireText(requestDigest, "EINTENT", "requestDigest");
    if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) {
      throw codedError("EINTENT", "fencingToken must be a positive safe integer");
    }
    return this._immediate(() => {
      if (this._insertIntent.run(id, requestDigest, fencingToken).changes === 1) return true;
      const existing = this._select.get(id);
      if (existing?.request_digest === requestDigest && Number(existing.fencing_token) === fencingToken) return false;
      throw codedError("EINTENTCONFLICT", "dispatch id already belongs to a different intent");
    });
  }

  markSent(id) {
    requireText(id, "ETRANSITION", "id");
    return this._immediate(() => {
      if (this._markSent.run(id).changes === 1) return true;
      const existing = this._select.get(id);
      if (existing?.status === "sent") return false;
      throw codedError("ETRANSITION", "only an intent can transition to sent");
    });
  }

  markConfirmed(id, { threadId, turnId } = {}) {
    requireText(id, "ETRANSITION", "id");
    requireText(threadId, "ECONFIRMATION", "threadId");
    requireText(turnId, "ECONFIRMATION", "turnId");
    return this._immediate(() => {
      if (this._markConfirmed.run(threadId, turnId, id).changes === 1) return true;
      const existing = this._select.get(id);
      if (existing?.status === "confirmed") {
        if (existing.thread_id === threadId && existing.turn_id === turnId) return false;
        throw codedError("ECONFIRMCONFLICT", "dispatch is confirmed with a different remote identity");
      }
      throw codedError("ETRANSITION", "only a sent dispatch can transition to confirmed");
    });
  }

  get(id) {
    requireText(id, "EINTENT", "id");
    return publicRow(this._select.get(id));
  }

  reconcile() {
    return this._immediate(() => {
      const rows = this._unresolved.all();
      if (rows.length === 0) return Object.freeze([]);
      this._markUnknown.run();
      return Object.freeze(rows.map(({ id }) => Object.freeze({ id, resolution: "unknown", autoReplay: false })));
    });
  }
}

export function probeDispatchRecovery() {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-dispatch-probe-"));
  const file = path.join(directory, "journal.sqlite");
  let first = null;
  let second = null;
  try {
    first = new DatabaseSync(file);
    const initial = new DispatchJournal(first);
    initial.createIntent({ id: "phase0", requestDigest: "fixed-probe", fencingToken: 1 });
    initial.markSent("phase0");
    first.close();
    first = null;

    second = new DatabaseSync(file);
    const result = new DispatchJournal(second).reconcile();
    second.close();
    second = null;
    return Object.freeze({
      status: result.length === 1 && result[0].autoReplay === false ? "pass" : "fail",
      result,
      reopened: true,
    });
  } finally {
    try { first?.close(); } catch { /* best-effort close before deleting owned fixture */ }
    try { second?.close(); } catch { /* best-effort close before deleting owned fixture */ }
    rmSync(directory, { recursive: true, force: true });
  }
}
