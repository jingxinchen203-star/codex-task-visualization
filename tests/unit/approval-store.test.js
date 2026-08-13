import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApprovalStore, digestApproval } from "../../src/approvals/approval-store.js";

const request = Object.freeze({
  instanceId: "instance-a",
  requestId: 7,
  requestMethod: "item/commandExecution/requestApproval",
  threadId: "thr",
  turnId: "turn",
  itemId: "item",
  command: "Get-Location",
  cwd: "C:\\tmp",
  scope: Object.freeze({
    network: null,
    additionalPermissions: Object.freeze({ read: true, write: false }),
    grantRoot: null,
  }),
});

function response(overrides = {}) {
  return {
    requestId: request.requestId,
    responder: "human-ui",
    instanceId: request.instanceId,
    digest: digestApproval(request),
    decision: "decline",
    ...overrides,
  };
}

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-approval-"));
  return {
    directory,
    file: path.join(directory, "approval.sqlite"),
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test("approval digest is canonical and binds every execution identity field", () => {
  const reordered = {
    scope: { grantRoot: null, additionalPermissions: { write: false, read: true }, network: null },
    cwd: "C:\\tmp",
    command: "Get-Location",
    itemId: "item",
    turnId: "turn",
    threadId: "thr",
    requestMethod: "item/commandExecution/requestApproval",
    requestId: 7,
    instanceId: "instance-a",
  };
  const digest = digestApproval(request);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digestApproval(reordered), digest);

  for (const changed of [
    { ...request, instanceId: "instance-b" },
    { ...request, requestId: 8 },
    { ...request, requestMethod: "item/fileChange/requestApproval" },
    { ...request, threadId: "other-thread" },
    { ...request, turnId: "other-turn" },
    { ...request, itemId: "other-item" },
    { ...request, command: "Remove-Item marker.txt" },
    { ...request, cwd: "C:\\other" },
    { ...request, scope: { ...request.scope, network: "example.com" } },
    { ...request, scope: { ...request.scope, additionalPermissions: { read: true, write: true } } },
    { ...request, scope: { ...request.scope, grantRoot: "C:\\grant" } },
  ]) {
    assert.notEqual(digestApproval(changed), digest);
  }
});

test("approval digest rejects non-JSON scope and binds specified nullish fallbacks", () => {
  assert.throws(
    () => digestApproval({ ...request, scope: "network" }),
    (error) => error.code === "EAPPROVALREQUEST",
  );
  const sparse = [];
  sparse[1] = "read";
  assert.throws(
    () => digestApproval({ ...request, scope: { ...request.scope, additionalPermissions: sparse } }),
    (error) => error.code === "EAPPROVALREQUEST",
  );
  assert.throws(
    () => digestApproval({ ...request, scope: { ...request.scope, futurePermission: true } }),
    (error) => error.code === "EAPPROVALREQUEST",
  );
  assert.notEqual(
    digestApproval({ ...request, network: "alpha.example" }),
    digestApproval({ ...request, network: "beta.example" }),
  );
});

test("only the human UI may answer and rejection preserves the pending approval", () => {
  const database = new DatabaseSync(":memory:");
  const store = new ApprovalStore(database, () => 1000);
  store.add(request, 5000);
  assert.throws(
    () => store.respond(response({ responder: "mcp-agent" })),
    (error) => error.code === "ERESPONDER" && /human-ui/.test(error.message),
  );
  assert.equal(store.get(request.instanceId, request.requestId).status, "pending");
  database.close();
});

test("an approval expires at its deadline and can never be answered afterward", () => {
  let now = 1000;
  const database = new DatabaseSync(":memory:");
  const store = new ApprovalStore(database, () => now);
  store.add(request, 5000);
  now = 5000;
  assert.throws(
    () => store.respond(response()),
    (error) => error.code === "EAPPROVALEXPIRED",
  );
  assert.equal(store.get(request.instanceId, request.requestId).status, "expired");
  assert.throws(() => store.respond(response()), (error) => error.code === "EAPPROVALEXPIRED");
  database.close();
});

test("expiry is sampled only after the SQLite write transaction is acquired", () => {
  let now = 1000;
  let advanceAtBegin = false;
  const database = new DatabaseSync(":memory:");
  const delayedDatabase = {
    exec(statement) {
      if (statement === "BEGIN IMMEDIATE" && advanceAtBegin) {
        now = 5000;
        advanceAtBegin = false;
      }
      return database.exec(statement);
    },
    prepare(statement) { return database.prepare(statement); },
  };
  const store = new ApprovalStore(delayedDatabase, () => now);

  advanceAtBegin = true;
  assert.throws(() => store.add(request, 5000), (error) => error.code === "EAPPROVALEXPIRY");
  assert.equal(store.get(request.instanceId, request.requestId), null);

  now = 1000;
  store.add(request, 5000);
  advanceAtBegin = true;
  assert.throws(() => store.respond(response()), (error) => error.code === "EAPPROVALEXPIRED");
  assert.equal(store.get(request.instanceId, request.requestId).status, "expired");
  database.close();
});

test("reading a pending approval at its deadline durably expires it", () => {
  let now = 1000;
  const database = new DatabaseSync(":memory:");
  const store = new ApprovalStore(database, () => now);
  store.add(request, 5000);
  now = 5000;
  assert.equal(store.get(request.instanceId, request.requestId).status, "expired");
  assert.equal(database.prepare(
    "SELECT status FROM approvals WHERE instance_id='instance-a' AND request_id='7'",
  ).get().status, "expired");
  database.close();
});

test("changed instance or digest is rejected without consuming the pending approval", () => {
  const database = new DatabaseSync(":memory:");
  const store = new ApprovalStore(database, () => 1000);
  store.add(request, 5000);
  assert.throws(
    () => store.respond(response({ instanceId: "instance-b" })),
    (error) => error.code === "EAPPROVALIDENTITY",
  );
  assert.throws(
    () => store.respond(response({ digest: digestApproval({ ...request, command: "changed" }) })),
    (error) => error.code === "EAPPROVALIDENTITY",
  );
  assert.equal(store.get(request.instanceId, request.requestId).status, "pending");
  assert.deepEqual(store.respond(response()), {
    requestId: 7,
    decision: "decline",
    replayed: false,
  });
  database.close();
});

test("identical responses are idempotent while conflicting decisions fail closed", () => {
  const database = new DatabaseSync(":memory:");
  const store = new ApprovalStore(database, () => 1000);
  store.add(request, 5000);
  const accepted = response({ decision: "accept" });
  assert.deepEqual(store.respond(accepted), { requestId: 7, decision: "accept", replayed: false });
  assert.deepEqual(store.respond(accepted), { requestId: 7, decision: "accept", replayed: true });
  assert.throws(
    () => store.respond(response({ decision: "decline" })),
    (error) => error.code === "EAPPROVALSETTLED",
  );
  assert.equal(store.get(request.instanceId, request.requestId).responder, "human-ui");
  database.close();
});

test("unknown decisions are rejected without consuming the pending approval", () => {
  const database = new DatabaseSync(":memory:");
  const store = new ApprovalStore(database, () => 1000);
  store.add(request, 5000);
  assert.throws(
    () => store.respond(response({ decision: "accept-later" })),
    (error) => error.code === "EAPPROVALDECISION",
  );
  assert.equal(store.get(request.instanceId, request.requestId).status, "pending");
  database.close();
});

test("pending and answered approvals survive database reopen", () => {
  const fixture = temporaryDatabase();
  try {
    const first = new DatabaseSync(fixture.file);
    assert.equal(new ApprovalStore(first, () => 1000).add(request, 5000), true);
    first.close();

    const second = new DatabaseSync(fixture.file);
    const reopened = new ApprovalStore(second, () => 2000);
    assert.deepEqual(reopened.respond(response()), { requestId: 7, decision: "decline", replayed: false });
    second.close();

    const third = new DatabaseSync(fixture.file);
    const persisted = new ApprovalStore(third, () => 3000);
    assert.deepEqual(persisted.respond(response()), { requestId: 7, decision: "decline", replayed: true });
    assert.deepEqual(persisted.get(request.instanceId, request.requestId), {
      instanceId: "instance-a",
      requestId: "7",
      digest: digestApproval(request),
      expiresAt: 5000,
      status: "denied",
      decision: "decline",
      responder: "human-ui",
      respondedAt: 2000,
    });
    third.close();
  } finally {
    fixture.cleanup();
  }
});

test("adding an exact request is idempotent but a colliding identity is rejected", () => {
  const database = new DatabaseSync(":memory:");
  const store = new ApprovalStore(database, () => 1000);
  assert.equal(store.add(request, 5000), true);
  assert.equal(store.add(request, 5000), false);
  assert.throws(
    () => store.add({ ...request, command: "changed" }, 5000),
    (error) => error.code === "EAPPROVALCONFLICT",
  );
  assert.equal(store.add({ ...request, instanceId: "instance-b" }, 5000), true);
  database.close();
});

test("store validates request identities, deadlines, and durable constraints", () => {
  const fixture = temporaryDatabase();
  let database = null;
  try {
    database = new DatabaseSync(fixture.file);
    const store = new ApprovalStore(database, () => 1000);
    assert.equal(String(database.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase(), "wal");
    assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(database.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    assert.equal(database.prepare("PRAGMA synchronous").get().synchronous, 2);

    for (const invalid of [
      { ...request, instanceId: "" },
      { ...request, requestId: null },
      { ...request, requestMethod: "" },
    ]) {
      assert.throws(() => store.add(invalid, 5000), (error) => error.code === "EAPPROVALREQUEST");
    }
    assert.throws(() => store.add(request, 1000), (error) => error.code === "EAPPROVALEXPIRY");
    assert.throws(() => store.add(request, Number.MAX_SAFE_INTEGER + 1), (error) => error.code === "EAPPROVALEXPIRY");

    store.add(request, 5000);
    assert.throws(
      () => store.get("", request.requestId),
      (error) => error.code === "EAPPROVALIDENTITY",
    );
    assert.throws(() => database.prepare(
      "UPDATE approvals SET digest=? WHERE instance_id='instance-a' AND request_id='7'",
    ).run("z".repeat(64)));
    assert.throws(() => database.prepare(`
      UPDATE approvals
      SET status='approved', decision='accept', responder='human-ui', responded_at='abc'
      WHERE instance_id='instance-a' AND request_id='7'
    `).run());
    assert.throws(() => database.prepare(
      "UPDATE approvals SET status='approved', decision=NULL WHERE instance_id='instance-a' AND request_id='7'",
    ).run());
    database.close();
    database = null;
  } finally {
    try { database?.close(); } catch { /* preserve the assertion failure */ }
    fixture.cleanup();
  }
});
