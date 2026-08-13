import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DispatchJournal, probeDispatchRecovery } from "../../src/journal/dispatch-journal.js";

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-journal-"));
  return {
    directory,
    file: path.join(directory, "journal.sqlite"),
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test("sent but unconfirmed dispatch becomes unknown once after reopen and is never replayed", () => {
  const fixture = temporaryDatabase();
  try {
    const first = new DatabaseSync(fixture.file);
    const journal = new DispatchJournal(first);
    assert.equal(journal.createIntent({ id: "run-1", requestDigest: "abc", fencingToken: 1 }), true);
    assert.equal(journal.markSent("run-1"), true);
    first.close();

    const second = new DatabaseSync(fixture.file);
    const reopened = new DispatchJournal(second);
    assert.deepEqual(reopened.reconcile(), [{ id: "run-1", resolution: "unknown", autoReplay: false }]);
    assert.deepEqual(reopened.reconcile(), []);
    assert.deepEqual(reopened.get("run-1"), {
      id: "run-1",
      requestDigest: "abc",
      fencingToken: 1,
      status: "unknown",
      threadId: null,
      turnId: null,
    });
    second.close();
  } finally {
    fixture.cleanup();
  }
});

test("an intent at a crash boundary also fails closed without replay", () => {
  const database = new DatabaseSync(":memory:");
  const journal = new DispatchJournal(database);
  journal.createIntent({ id: "run-intent", requestDigest: "digest", fencingToken: 2 });
  assert.deepEqual(journal.reconcile(), [{ id: "run-intent", resolution: "unknown", autoReplay: false }]);
  assert.throws(() => journal.markSent("run-intent"), (error) => error.code === "ETRANSITION");
  database.close();
});

test("confirmed dispatch remains confirmed and preserves its remote identity", () => {
  const database = new DatabaseSync(":memory:");
  const journal = new DispatchJournal(database);
  journal.createIntent({ id: "run-2", requestDigest: "def", fencingToken: 3 });
  journal.markSent("run-2");
  assert.equal(journal.markConfirmed("run-2", { threadId: "thr", turnId: "turn" }), true);
  assert.equal(journal.markConfirmed("run-2", { threadId: "thr", turnId: "turn" }), false);
  assert.deepEqual(journal.reconcile(), []);
  assert.equal(journal.get("run-2").status, "confirmed");
  assert.equal(journal.get("run-2").threadId, "thr");
  assert.equal(journal.get("run-2").turnId, "turn");
  database.close();
});

test("reconcile atomically fences every unresolved row in deterministic order", () => {
  const database = new DatabaseSync(":memory:");
  const journal = new DispatchJournal(database);
  journal.createIntent({ id: "z-sent", requestDigest: "z", fencingToken: 1 });
  journal.markSent("z-sent");
  journal.createIntent({ id: "a-intent", requestDigest: "a", fencingToken: 2 });
  journal.createIntent({ id: "m-confirmed", requestDigest: "m", fencingToken: 3 });
  journal.markSent("m-confirmed");
  journal.markConfirmed("m-confirmed", { threadId: "thread", turnId: "turn" });

  assert.deepEqual(journal.reconcile(), [
    { id: "a-intent", resolution: "unknown", autoReplay: false },
    { id: "z-sent", resolution: "unknown", autoReplay: false },
  ]);
  assert.equal(journal.get("a-intent").status, "unknown");
  assert.equal(journal.get("z-sent").status, "unknown");
  assert.equal(journal.get("m-confirmed").status, "confirmed");
  assert.equal(Object.isFrozen(journal.get("m-confirmed")), true);
  database.close();
});

test("file journal enables durable pragmas and database constraints", () => {
  const fixture = temporaryDatabase();
  try {
    const database = new DatabaseSync(fixture.file);
    const journal = new DispatchJournal(database);
    assert.equal(String(database.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase(), "wal");
    assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(database.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    assert.equal(database.prepare("PRAGMA synchronous").get().synchronous, 2);

    journal.createIntent({ id: "constrained", requestDigest: "digest", fencingToken: 1 });
    assert.throws(() => database.prepare(
      "UPDATE dispatch_journal SET thread_id='thread' WHERE id='constrained'",
    ).run());
    database.close();
  } finally {
    fixture.cleanup();
  }
});

test("intent and confirmation retries are idempotent but conflicting identities fail", () => {
  const database = new DatabaseSync(":memory:");
  const journal = new DispatchJournal(database);
  const intent = { id: "run-idempotent", requestDigest: "fixed", fencingToken: 7 };
  assert.equal(journal.createIntent(intent), true);
  assert.equal(journal.createIntent(intent), false);
  assert.throws(
    () => journal.createIntent({ ...intent, requestDigest: "changed" }),
    (error) => error.code === "EINTENTCONFLICT",
  );
  assert.equal(journal.markSent(intent.id), true);
  assert.equal(journal.markSent(intent.id), false);
  assert.equal(journal.markConfirmed(intent.id, { threadId: "thread", turnId: "turn" }), true);
  assert.throws(
    () => journal.markConfirmed(intent.id, { threadId: "other", turnId: "turn" }),
    (error) => error.code === "ECONFIRMCONFLICT",
  );
  database.close();
});

test("journal validates durable identities and transition order", () => {
  const database = new DatabaseSync(":memory:");
  const journal = new DispatchJournal(database);
  for (const value of [
    { id: "", requestDigest: "d", fencingToken: 1 },
    { id: "id", requestDigest: "", fencingToken: 1 },
    { id: "id", requestDigest: "d", fencingToken: 0 },
    { id: "id", requestDigest: "d", fencingToken: 1.5 },
  ]) {
    assert.throws(() => journal.createIntent(value), (error) => error.code === "EINTENT");
  }
  assert.throws(() => journal.markSent("missing"), (error) => error.code === "ETRANSITION");
  journal.createIntent({ id: "ordered", requestDigest: "d", fencingToken: 1 });
  assert.throws(
    () => journal.markConfirmed("ordered", { threadId: "thread", turnId: "turn" }),
    (error) => error.code === "ETRANSITION",
  );
  assert.throws(
    () => journal.markConfirmed("ordered", { threadId: "", turnId: "turn" }),
    (error) => error.code === "ECONFIRMATION",
  );
  database.close();
});

test("probeDispatchRecovery is deterministic and reports no replay", () => {
  const first = probeDispatchRecovery();
  const second = probeDispatchRecovery();
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    status: "pass",
    result: [{ id: "phase0", resolution: "unknown", autoReplay: false }],
    reopened: true,
  });
});
