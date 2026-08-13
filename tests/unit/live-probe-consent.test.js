import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApprovalStore } from "../../src/approvals/approval-store.js";
import {
  createVisibilityMarker,
  evaluateStartRace,
  raceTurnStart,
  runDeclineOnlyApprovalProbe,
  runLiveSuite,
  validateLiveConsent,
} from "../../src/live/live-probes.js";

function conflict(reason = "activeTurn") {
  return Object.assign(new Error("thread has an active turn"), {
    rpc: { code: -32000, data: { reason } },
  });
}

test("live probes require both persistent-thread and model-turn consent", () => {
  for (const options of [
    {},
    { allowPersistentThread: false, allowModelTurns: false },
    { allowPersistentThread: true, allowModelTurns: false },
    { allowPersistentThread: false, allowModelTurns: true },
    { allowPersistentThread: "yes", allowModelTurns: true },
  ]) {
    assert.throws(() => validateLiveConsent(options), /explicit|persistent thread|model turns|boolean/u);
  }
  const consent = validateLiveConsent({ allowPersistentThread: true, allowModelTurns: true });
  assert.deepEqual(consent, { persistentThreads: 1, modelTurns: 2, approvals: "decline-only" });
  assert.equal(Object.isFrozen(consent), true);
});

test("double-start passes only for one valid turn and one structured active-turn conflict", () => {
  assert.deepEqual(evaluateStartRace([
    { status: "fulfilled", value: { turn: { id: "turn-a" } } },
    { status: "rejected", reason: conflict() },
  ]), {
    status: "pass",
    accepted: 1,
    explicitConflict: true,
    acceptedIndex: 0,
    acceptedTurnId: "turn-a",
    conflict: { code: -32000, reason: "activeTurn" },
  });

  for (const results of [
    [
      { status: "fulfilled", value: { turn: { id: "turn-a" } } },
      { status: "fulfilled", value: { turn: { id: "turn-b" } } },
    ],
    [
      { status: "fulfilled", value: { turn: { id: "turn-a" } } },
      { status: "rejected", reason: new Error("transport timed out") },
    ],
    [
      { status: "fulfilled", value: { turn: {} } },
      { status: "rejected", reason: conflict() },
    ],
    [
      { status: "rejected", reason: conflict() },
      { status: "rejected", reason: conflict("threadBusy") },
    ],
    [
      { status: "fulfilled", value: { turn: { id: "turn-a" } } },
      { status: "rejected", reason: conflict("notActiveTurn") },
    ],
    [
      { status: "fulfilled", value: { turn: { id: "turn-a" } } },
      {
        status: "rejected",
        reason: Object.assign(new Error("active turn"), {
          rpc: { code: 123, data: { reason: "activeTurn" } },
        }),
      },
    ],
  ]) {
    assert.equal(evaluateStartRace(results).status, "fail");
  }
  assert.throws(() => evaluateStartRace([]), /two results/u);
});

test("visibility marker creates one read-only named probe thread", async () => {
  const calls = [];
  const peer = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-marker" } };
      if (method === "thread/name/set") return {};
      throw new Error(`unexpected method: ${method}`);
    },
  };
  const marker = await createVisibilityMarker(peer, "C:\\fixture", { uuid: () => "fixed-id" });
  assert.deepEqual(marker, {
    threadId: "thread-marker",
    marker: "[Projectboard Phase 0] fixed-id",
  });
  assert.equal(Object.isFrozen(marker), true);
  assert.deepEqual(calls, [
    {
      method: "thread/start",
      params: {
        cwd: "C:\\fixture",
        approvalPolicy: "never",
        sandbox: "read-only",
        serviceName: "projectboard_phase0",
      },
    },
    {
      method: "thread/name/set",
      params: { threadId: "thread-marker", name: "[Projectboard Phase 0] fixed-id" },
    },
  ]);
});

test("turn-start race dispatches both read-only requests before awaiting either result", async () => {
  const calls = [];
  const resolvers = [];
  const peer = (label) => ({
    request(method, params) {
      calls.push({ label, method, params });
      return new Promise((resolve, reject) => resolvers.push({ label, resolve, reject }));
    },
  });
  const raced = raceTurnStart(peer("A"), peer("B"), "thread-a");
  assert.deepEqual(calls.map(({ label, method }) => [label, method]), [
    ["A", "turn/start"],
    ["B", "turn/start"],
  ]);
  const conflictError = conflict();
  resolvers[0].resolve({ turn: { id: "turn-a" } });
  resolvers[1].reject(conflictError);
  const results = await raced;
  assert.deepEqual(results, [
    { status: "fulfilled", value: { turn: { id: "turn-a" } } },
    { status: "rejected", reason: conflictError },
  ]);
  for (const call of calls) {
    assert.equal(call.params.threadId, "thread-a");
    assert.equal(call.params.approvalPolicy, "never");
    assert.deepEqual(call.params.sandboxPolicy, { type: "readOnly" });
  }
});

class ApprovalPeer extends EventEmitter {
  constructor({
    markerExists = false,
    startedTurnId = "turn-approval",
    approvalTurnId = startedTurnId,
    emitApproval = true,
    emitCompletionWithoutApproval = false,
    startError = null,
  } = {}) {
    super();
    this.markerExists = markerExists;
    this.startedTurnId = startedTurnId;
    this.approvalTurnId = approvalTurnId;
    this.emitApproval = emitApproval;
    this.emitCompletionWithoutApproval = emitCompletionWithoutApproval;
    this.startError = startError;
    this.outbound = [];
    this.serverRequests = [];
    this.notifications = [];
  }

  async request(method, params) {
    this.outbound.push({ method, params });
    if (method !== "turn/start") throw new Error(`unexpected method: ${method}`);
    const approval = {
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: params.threadId,
        turnId: this.approvalTurnId,
        itemId: "item-approval",
        command: "Set-Content marker.txt probe",
        cwd: "C:\\fixture",
        networkApprovalContext: null,
        additionalPermissions: null,
        grantRoot: null,
      },
    };
    if (this.emitApproval) {
      queueMicrotask(() => {
        this.serverRequests.push(approval);
        this.emit("serverRequest", approval);
      });
    } else if (this.emitCompletionWithoutApproval) {
      queueMicrotask(() => {
        const completed = {
          method: "turn/completed",
          params: { turn: { id: this.startedTurnId, status: "completed" } },
        };
        this.notifications.push(completed);
        this.emit("notification", completed);
      });
    }
    if (this.startError) throw this.startError;
    return { turn: { id: this.startedTurnId } };
  }

  async respond(id, result) {
    this.outbound.push({ id, result });
    const messages = [
      { method: "serverRequest/resolved", params: { requestId: id } },
      { method: "item/completed", params: { item: { id: "item-approval", status: "declined" } } },
      { method: "turn/completed", params: { turn: { id: this.approvalTurnId, status: "completed" } } },
    ];
    for (const message of messages) {
      this.notifications.push(message);
      this.emit("notification", message);
    }
  }
}

test("approval probe persists identity and sends only a fixed decline before observing completion", async () => {
  const database = new DatabaseSync(":memory:");
  const approvalStore = new ApprovalStore(database, () => 1000);
  const peer = new ApprovalPeer();
  const displayed = [];
  peer.serverRequests.push({
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-live",
      turnId: "stale-turn",
      itemId: "stale-item",
      command: "stale command",
      cwd: "C:\\fixture",
    },
  });
  const result = await runDeclineOnlyApprovalProbe(peer, {
    instanceId: "instance-live",
    threadId: "thread-live",
    markerPath: "C:\\fixture\\marker.txt",
    approvalStore,
    now: () => 1000,
    exists: async () => false,
    eventTimeoutMs: 100,
    displayApproval: async (evidence) => {
      displayed.push(evidence);
      assert.equal(approvalStore.get("instance-live", 91).status, "pending");
      assert.deepEqual(peer.outbound.map((message) => message.method ?? "response"), ["turn/start"]);
    },
  });

  assert.deepEqual(result, {
    status: "pass",
    requestMethod: "item/commandExecution/requestApproval",
    requestId: 91,
    decision: "decline",
    markerAbsent: true,
    itemStatus: "declined",
  });
  assert.deepEqual(peer.outbound.map((message) => message.method ?? "response"), ["turn/start", "response"]);
  assert.deepEqual(peer.outbound[1], { id: 91, result: { decision: "decline" } });
  const stored = approvalStore.get("instance-live", 91);
  assert.equal(stored.status, "denied");
  assert.equal(stored.decision, "decline");
  assert.equal(stored.responder, "human-ui");
  assert.deepEqual(displayed, [{
    requestId: 91,
    requestMethod: "item/commandExecution/requestApproval",
    threadId: "thread-live",
    turnId: "turn-approval",
    itemId: "item-approval",
    command: "Set-Content marker.txt probe",
    cwd: "C:\\fixture",
    scope: { network: null, additionalPermissions: null, grantRoot: null },
    digest: stored.digest,
    fixedDecision: "decline",
  }]);
  assert.equal(Object.isFrozen(displayed[0]), true);
  assert.equal(Object.isFrozen(displayed[0].scope), true);
  database.close();
});

test("approval probe reports marker creation as failure without changing its fixed decision", async () => {
  const database = new DatabaseSync(":memory:");
  const approvalStore = new ApprovalStore(database, () => 1000);
  const peer = new ApprovalPeer({ markerExists: true });
  const result = await runDeclineOnlyApprovalProbe(peer, {
    instanceId: "instance-live",
    threadId: "thread-live",
    markerPath: "C:\\fixture\\marker.txt",
    approvalStore,
    now: () => 1000,
    exists: async () => peer.markerExists,
    eventTimeoutMs: 100,
  });
  assert.equal(result.status, "fail");
  assert.equal(result.markerAbsent, false);
  assert.deepEqual(peer.outbound.at(-1), { id: 91, result: { decision: "decline" } });
  database.close();
});

test("approval probe rejects a request from a different turn without persisting or responding", async () => {
  const database = new DatabaseSync(":memory:");
  const approvalStore = new ApprovalStore(database, () => 1000);
  const peer = new ApprovalPeer({ startedTurnId: "turn-started", approvalTurnId: "turn-other" });
  await assert.rejects(
    runDeclineOnlyApprovalProbe(peer, {
      instanceId: "instance-live",
      threadId: "thread-live",
      markerPath: "C:\\fixture\\marker.txt",
      approvalStore,
      now: () => 1000,
      exists: async () => false,
      eventTimeoutMs: 100,
    }),
    (error) => error.code === "EAPPROVALMESSAGE" && /turn/u.test(error.message),
  );
  assert.deepEqual(peer.outbound.map((message) => message.method ?? "response"), [
    "turn/start",
    "turn/interrupt",
    "thread/read",
  ]);
  assert.deepEqual(peer.outbound[1].params, {
    threadId: "thread-live",
    turnId: "turn-started",
  });
  assert.deepEqual(peer.outbound[2].params, {
    threadId: "thread-live",
    includeTurns: true,
  });
  assert.equal(approvalStore.get("instance-live", 91), null);
  database.close();
});

test("approval probe interrupts its turn before reporting that no approval request appeared", async () => {
  const database = new DatabaseSync(":memory:");
  const approvalStore = new ApprovalStore(database, () => 1000);
  const peer = new ApprovalPeer({ emitApproval: false, startedTurnId: "turn-no-approval" });
  const originalRequest = peer.request.bind(peer);
  peer.request = async (method, params) => {
    if (method === "turn/interrupt") {
      peer.outbound.push({ method, params });
      return {};
    }
    return originalRequest(method, params);
  };
  const result = await runDeclineOnlyApprovalProbe(peer, {
    instanceId: "instance-live",
    threadId: "thread-live",
    markerPath: "C:\\fixture\\marker.txt",
    approvalStore,
    now: () => 1000,
    exists: async () => false,
    eventTimeoutMs: 10,
  });
  assert.deepEqual(result, {
    status: "inconclusive",
    reason: "no approval request",
    interrupted: true,
  });
  assert.deepEqual(peer.outbound.at(-1), {
    method: "turn/interrupt",
    params: { threadId: "thread-live", turnId: "turn-no-approval" },
  });
  database.close();
});

test("approval probe returns inconclusive without interrupting a turn that completed without approval", async () => {
  const database = new DatabaseSync(":memory:");
  const approvalStore = new ApprovalStore(database, () => 1000);
  const peer = new ApprovalPeer({
    emitApproval: false,
    emitCompletionWithoutApproval: true,
    startedTurnId: "turn-completed-no-approval",
  });
  const result = await runDeclineOnlyApprovalProbe(peer, {
    instanceId: "instance-live",
    threadId: "thread-live",
    markerPath: "C:\\fixture\\marker.txt",
    approvalStore,
    now: () => 1000,
    exists: async () => false,
    eventTimeoutMs: 100,
  });
  assert.deepEqual(result, {
    status: "inconclusive",
    reason: "turn completed without approval request",
    interrupted: false,
  });
  assert.deepEqual(peer.outbound.map(({ method }) => method), ["turn/start"]);
  database.close();
});

test("approval timeout accepts exact terminal evidence after a stale interrupt rejection", async () => {
  const database = new DatabaseSync(":memory:");
  const approvalStore = new ApprovalStore(database, () => 1000);
  const peer = new ApprovalPeer({ emitApproval: false, startedTurnId: "turn-terminal-after-timeout" });
  const originalRequest = peer.request.bind(peer);
  peer.request = async (method, params) => {
    if (method === "turn/interrupt") {
      peer.outbound.push({ method, params });
      throw new Error("no active turn to interrupt");
    }
    if (method === "thread/read") {
      peer.outbound.push({ method, params });
      return {
        thread: {
          id: "thread-live",
          turns: [{ id: "turn-terminal-after-timeout", status: "completed" }],
        },
      };
    }
    return originalRequest(method, params);
  };
  const result = await runDeclineOnlyApprovalProbe(peer, {
    instanceId: "instance-live",
    threadId: "thread-live",
    markerPath: "C:\\fixture\\marker.txt",
    approvalStore,
    now: () => 1000,
    exists: async () => false,
    eventTimeoutMs: 5,
  });
  assert.deepEqual(result, {
    status: "inconclusive",
    reason: "turn completed without approval request",
    interrupted: false,
  });
  assert.deepEqual(peer.outbound.slice(-2).map(({ method }) => method), ["turn/interrupt", "thread/read"]);
  database.close();
});

test("approval probe interrupts a newly evidenced turn when turn/start rejects", async () => {
  const database = new DatabaseSync(":memory:");
  const approvalStore = new ApprovalStore(database, () => 1000);
  const startError = Object.assign(new Error("turn/start response was lost"), { code: "ETRANSPORT" });
  const peer = new ApprovalPeer({
    startedTurnId: "turn-rejected-response",
    approvalTurnId: "turn-evidenced",
    startError,
  });
  await assert.rejects(
    runDeclineOnlyApprovalProbe(peer, {
      instanceId: "instance-live",
      threadId: "thread-live",
      markerPath: "C:\\fixture\\marker.txt",
      approvalStore,
      now: () => 1000,
      exists: async () => false,
      eventTimeoutMs: 100,
    }),
    (error) => error === startError,
  );
  assert.deepEqual(peer.outbound.map((message) => message.method ?? "response"), [
    "turn/start",
    "turn/interrupt",
  ]);
  assert.deepEqual(peer.outbound[1].params, {
    threadId: "thread-live",
    turnId: "turn-evidenced",
  });
  database.close();
});

test("approval probe interrupts an evidenced turn when turn/start fulfills without an id", async () => {
  const database = new DatabaseSync(":memory:");
  const approvalStore = new ApprovalStore(database, () => 1000);
  const peer = new ApprovalPeer({
    startedTurnId: null,
    approvalTurnId: "turn-evidenced",
  });
  await assert.rejects(
    runDeclineOnlyApprovalProbe(peer, {
      instanceId: "instance-live",
      threadId: "thread-live",
      markerPath: "C:\\fixture\\marker.txt",
      approvalStore,
      now: () => 1000,
      exists: async () => false,
      eventTimeoutMs: 100,
    }),
    (error) => error.code === "EAPPROVALMESSAGE",
  );
  assert.deepEqual(peer.outbound.map((message) => message.method ?? "response"), [
    "turn/start",
    "turn/interrupt",
  ]);
  assert.deepEqual(peer.outbound[1].params, {
    threadId: "thread-live",
    turnId: "turn-evidenced",
  });
  database.close();
});

class LiveSuitePeer extends EventEmitter {
  constructor(label) {
    super();
    this.label = label;
    this.outbound = [];
    this.serverRequests = [];
    this.notifications = [];
  }

  async request(method, params) {
    this.outbound.push({ method, params });
    if (method === "thread/start" && !params.input) return { thread: { id: "thread-marker" } };
    if (method === "thread/read") {
      return {
        thread: {
          id: params.threadId,
          name: "[Projectboard Phase 0] fixed-live",
          ephemeral: false,
          turns: [],
        },
      };
    }
    if (method === "thread/name/set" || method === "thread/resume") return {};
    if (method === "turn/start" && this.label === "A") {
      const completed = { method: "turn/completed", params: { turn: { id: "turn-a", status: "completed" } } };
      queueMicrotask(() => {
        this.notifications.push(completed);
        this.emit("notification", completed);
      });
      return { turn: { id: "turn-a" } };
    }
    if (method === "turn/start" && this.label === "B") throw conflict();
    throw new Error(`unexpected ${this.label} method: ${method}`);
  }
}

function cleanClose() {
  return {
    settlement: { code: 0, signal: null, error: null, unsettled: false },
    disposal: { cleanup: { attempted: true, ok: true, error: null } },
    stderr: { text: "", bytes: 0, truncated: false },
  };
}

test("live suite rejects missing consent before opening an App Server", async () => {
  let opened = 0;
  await assert.rejects(
    runLiveSuite(
      { launchRecipe: { kind: "private-staged-snapshot" } },
      ["generated"],
      "C:\\fixture",
      async () => true,
      { open: async () => { opened += 1; } },
    ),
    /consent/u,
  );
  assert.equal(opened, 0);
});

test("existing marker recovery requires UUID task and marker identities before opening", async () => {
  let opened = 0;
  for (const existingMarker of [
    {
      threadId: "019fec51-b753-72f0-a4a6-6c822950d0de",
      marker: "[Projectboard Phase 0] a",
    },
    {
      threadId: "a",
      marker: "[Projectboard Phase 0] 41d75d85-75ff-4e96-9a18-9efce38b8dcd",
    },
  ]) {
    await assert.rejects(
      runLiveSuite(
        { launchRecipe: { kind: "private-staged-snapshot" } },
        ["generated"],
        "C:\\fixture",
        async () => true,
        {
          consent: { allowPersistentThread: true, allowModelTurns: true },
          existingMarker,
          mkdirImpl: async () => {},
          open: async () => { opened += 1; throw new Error("must not open"); },
        },
      ),
      /existingMarker/u,
    );
  }
  assert.equal(opened, 0);
});

test("live suite uses two owned initialized connections and always closes both", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-live-suite-"));
  const peers = [new LiveSuitePeer("A"), new LiveSuitePeer("B")];
  const opened = [];
  const initialized = [];
  const closed = [];
  let approvalCall = null;
  const displayApproval = async () => {};
  try {
    const result = await runLiveSuite(
      { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
      ["generated"],
      directory,
      async (marker) => marker.threadId === "thread-marker",
      {
        consent: { allowPersistentThread: true, allowModelTurns: true },
        open: async (candidate) => {
          const index = opened.length;
          opened.push(candidate);
          return {
            peer: peers[index],
            close: async () => { closed.push(index); return cleanClose(); },
          };
        },
        initialize: async (peer) => { initialized.push(peer.label); return { userAgent: `fake-${peer.label}` }; },
        approvalProbe: async (peer, options) => {
          approvalCall = { peer, options };
          return { status: "pass", decision: "decline" };
        },
        displayApproval,
        uuid: () => "fixed-live",
      },
    );

    assert.deepEqual(result, {
      quota: { persistentThreads: 1, modelTurns: 2, approvals: "decline-only" },
      marker: { threadId: "thread-marker", marker: "[Projectboard Phase 0] fixed-live" },
      appServerIdentity: {
        status: "pass",
        visibleAcrossProcesses: true,
        desktopConfirmed: true,
      },
      doubleWriteControl: {
        status: "pass",
        accepted: 1,
        explicitConflict: true,
        acceptedIndex: 0,
        acceptedTurnId: "turn-a",
        conflict: { code: -32000, reason: "activeTurn" },
      },
      approvalLifecycle: { status: "pass", decision: "decline" },
    });
    assert.equal(opened.length, 2);
    assert.deepEqual(initialized, ["A", "B"]);
    assert.deepEqual(closed.sort(), [0, 1]);
    assert.equal(approvalCall.peer, peers[0]);
    assert.equal(approvalCall.options.threadId, "thread-marker");
    assert.equal(approvalCall.options.instanceId, "phase0-thread-marker");
    assert.match(approvalCall.options.markerPath, /approval-marker-/u);
    assert.equal(approvalCall.options.approvalStore instanceof ApprovalStore, true);
    assert.equal(approvalCall.options.displayApproval, displayApproval);
    assert.deepEqual(peers[1].outbound.find(({ method }) => method === "thread/read"), {
      method: "thread/read",
      params: { threadId: "thread-marker", includeTurns: true },
    });
    assert.deepEqual(peers[1].outbound.find(({ method }) => method === "thread/resume"), {
      method: "thread/resume",
      params: { threadId: "thread-marker" },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live suite resumes one verified empty marker without creating a second task", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-live-resume-marker-"));
  const peers = [new LiveSuitePeer("A"), new LiveSuitePeer("B")];
  let nextPeer = 0;
  try {
    const result = await runLiveSuite(
      { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
      ["generated"],
      directory,
      async (marker) => marker.threadId === "019fec51-b753-72f0-a4a6-6c822950d0de",
      {
        consent: { allowPersistentThread: true, allowModelTurns: true },
        existingMarker: {
          threadId: "019fec51-b753-72f0-a4a6-6c822950d0de",
          marker: "[Projectboard Phase 0] deadbeef-dead-4eef-8ead-beefdeadbeef",
        },
        open: async () => {
          const peer = peers[nextPeer];
          nextPeer += 1;
          return { peer, close: async () => cleanClose() };
        },
        initialize: async () => ({}),
        readMarker: async (peer, marker) => (
          peer === peers[1]
          && marker.threadId === "019fec51-b753-72f0-a4a6-6c822950d0de"
          && marker.marker === "[Projectboard Phase 0] deadbeef-dead-4eef-8ead-beefdeadbeef"
        ),
        approvalProbe: async () => ({ status: "pass", decision: "decline" }),
        uuid: () => "approval-existing",
      },
    );

    assert.deepEqual(result.marker, {
      threadId: "019fec51-b753-72f0-a4a6-6c822950d0de",
      marker: "[Projectboard Phase 0] deadbeef-dead-4eef-8ead-beefdeadbeef",
    });
    assert.equal(result.appServerIdentity.status, "pass");
    assert.equal(result.doubleWriteControl.status, "pass");
    assert.equal(result.approvalLifecycle.status, "pass");
    const outbound = peers.flatMap((peer) => peer.outbound);
    assert.equal(outbound.some(({ method, params }) => method === "thread/start" && !params.input), false);
    assert.equal(outbound.some(({ method }) => method === "thread/name/set"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("existing marker recovery requires exact thread-read identity", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-live-resume-identity-"));
  const peers = [new LiveSuitePeer("A"), new LiveSuitePeer("B")];
  let nextPeer = 0;
  let confirmCalls = 0;
  try {
    const result = await runLiveSuite(
      { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
      ["generated"],
      directory,
      async () => { confirmCalls += 1; return true; },
      {
        consent: { allowPersistentThread: true, allowModelTurns: true },
        existingMarker: {
          threadId: "019fec51-b753-72f0-a4a6-6c822950d0de",
          marker: "[Projectboard Phase 0] deadbeef-dead-4eef-8ead-beefdeadbeef",
        },
        open: async () => {
          const peer = peers[nextPeer];
          nextPeer += 1;
          return { peer, close: async () => cleanClose() };
        },
        initialize: async () => ({}),
        readMarker: async () => false,
        approvalProbe: async () => ({ status: "pass", decision: "decline" }),
      },
    );

    assert.equal(result.appServerIdentity.status, "inconclusive");
    assert.equal(result.appServerIdentity.visibleAcrossProcesses, false);
    assert.equal(confirmCalls, 0);
    assert.equal(peers.flatMap((peer) => peer.outbound).some(({ method }) => method === "turn/start"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live suite skips desktop confirmation and all model turns when cross-process visibility fails", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-live-identity-"));
  const peers = [new LiveSuitePeer("A"), new LiveSuitePeer("B")];
  let nextPeer = 0;
  let confirmCalls = 0;
  let approvalCalls = 0;
  const closed = [];
  try {
    const result = await runLiveSuite(
      { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
      ["generated"],
      directory,
      async () => { confirmCalls += 1; throw new Error("desktop confirmation must be skipped"); },
      {
        consent: { allowPersistentThread: true, allowModelTurns: true },
        open: async () => {
          const index = nextPeer;
          nextPeer += 1;
          return {
            peer: peers[index],
            close: async () => { closed.push(index); return cleanClose(); },
          };
        },
        initialize: async () => ({}),
        readMarker: async () => false,
        approvalProbe: async () => { approvalCalls += 1; return { status: "pass" }; },
        uuid: () => "identity-fail",
      },
    );
    assert.equal(result.appServerIdentity.status, "inconclusive");
    assert.equal(result.appServerIdentity.visibleAcrossProcesses, false);
    assert.equal(result.appServerIdentity.desktopConfirmed, false);
    assert.equal(result.doubleWriteControl.status, "skipped");
    assert.equal(result.approvalLifecycle.status, "skipped");
    assert.equal(confirmCalls, 0);
    assert.equal(approvalCalls, 0);
    assert.equal(peers.flatMap((peer) => peer.outbound).some(({ method }) => method === "turn/start"), false);
    assert.deepEqual(closed.sort(), [0, 1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live suite preserves the primary error and closes every handle after a synchronous close failure", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-live-cleanup-"));
  const peers = [new LiveSuitePeer("A"), new LiveSuitePeer("B")];
  let nextPeer = 0;
  let secondClosed = false;
  try {
    const error = await runLiveSuite(
      { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
      ["generated"],
      directory,
      async () => true,
      {
        consent: { allowPersistentThread: true, allowModelTurns: true },
        open: async () => {
          const index = nextPeer;
          nextPeer += 1;
          return {
            peer: peers[index],
            close: index === 0
              ? () => { throw new Error("first close failed synchronously"); }
              : async () => { secondClosed = true; return cleanClose(); },
          };
        },
        initialize: async (peer) => {
          if (peer === peers[0]) throw new Error("initialize failed");
          return {};
        },
      },
    ).catch((value) => value);
    assert.equal(error.message, "initialize failed");
    assert.equal(secondClosed, true);
    assert.equal(error.cleanupErrors.length, 1);
    assert.equal(error.cleanupErrors[0].code, "ELIVECLEANUP");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live suite interrupts its accepted race turn when completion evidence times out", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-live-turn-timeout-"));
  const peers = [new LiveSuitePeer("A"), new LiveSuitePeer("B")];
  let nextPeer = 0;
  const originalARequest = peers[0].request.bind(peers[0]);
  peers[0].request = async (method, params) => {
    if (method === "turn/start" && params.input) {
      peers[0].outbound.push({ method, params });
      return { turn: { id: "turn-a" } };
    }
    if (method === "turn/interrupt") {
      peers[0].outbound.push({ method, params });
      return {};
    }
    return originalARequest(method, params);
  };
  try {
    const error = await runLiveSuite(
      { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
      ["generated"],
      directory,
      async () => true,
      {
        consent: { allowPersistentThread: true, allowModelTurns: true },
        open: async () => {
          const peer = peers[nextPeer];
          nextPeer += 1;
          return { peer, close: async () => cleanClose() };
        },
        initialize: async () => ({}),
        readMarker: async () => true,
        uuid: () => "turn-timeout",
        eventTimeoutMs: 5,
      },
    ).catch((value) => value);
    assert.equal(error.code, "ETIMEDOUT");
    assert.deepEqual(
      peers[0].outbound.filter(({ method }) => method === "turn/interrupt").map(({ params }) => params),
      [{ threadId: "thread-marker", turnId: "turn-a" }],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live suite exposes every failed interrupt after a double-write gate failure", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-live-interrupt-failure-"));
  const peers = [new LiveSuitePeer("A"), new LiveSuitePeer("B")];
  let nextPeer = 0;
  for (const [index, peer] of peers.entries()) {
    const originalRequest = peer.request.bind(peer);
    peer.request = async (method, params) => {
      if (method === "turn/start" && params.input) {
        peer.outbound.push({ method, params });
        return { turn: { id: `turn-${index}` } };
      }
      if (method === "turn/interrupt") {
        peer.outbound.push({ method, params });
        throw new Error(`interrupt ${index} failed`);
      }
      return originalRequest(method, params);
    };
  }
  try {
    const error = await runLiveSuite(
      { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
      ["generated"],
      directory,
      async () => true,
      {
        consent: { allowPersistentThread: true, allowModelTurns: true },
        open: async () => {
          const peer = peers[nextPeer];
          nextPeer += 1;
          return { peer, close: async () => cleanClose() };
        },
        initialize: async () => ({}),
        readMarker: async () => true,
        uuid: () => "interrupt-failure",
      },
    ).catch((value) => value);
    assert.equal(error.code, "ELIVEINTERRUPT");
    assert.equal(error.errors.length, 2);
    assert.deepEqual(
      peers.map((peer) => peer.outbound.filter(({ method }) => method === "turn/interrupt").length),
      [1, 1],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed double-write gate accepts exact terminal evidence after a stale interrupt rejection", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-live-terminal-interrupt-"));
  const peers = [new LiveSuitePeer("A"), new LiveSuitePeer("B")];
  let nextPeer = 0;
  const originalARequest = peers[0].request.bind(peers[0]);
  peers[0].request = async (method, params) => {
    if (method === "turn/interrupt") {
      peers[0].outbound.push({ method, params });
      throw new Error("no active turn to interrupt");
    }
    if (method === "thread/read") {
      peers[0].outbound.push({ method, params });
      return {
        thread: {
          id: params.threadId,
          turns: [{ id: "turn-a", status: "interrupted" }],
        },
      };
    }
    return originalARequest(method, params);
  };
  const originalBRequest = peers[1].request.bind(peers[1]);
  peers[1].request = async (method, params) => {
    if (method === "turn/start" && params.input) {
      peers[1].outbound.push({ method, params });
      throw new Error("conflict shape is not allowlisted");
    }
    return originalBRequest(method, params);
  };
  try {
    const result = await runLiveSuite(
      { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
      ["generated"],
      directory,
      async () => true,
      {
        consent: { allowPersistentThread: true, allowModelTurns: true },
        open: async () => {
          const peer = peers[nextPeer];
          nextPeer += 1;
          return { peer, close: async () => cleanClose() };
        },
        initialize: async () => ({}),
        readMarker: async () => true,
        uuid: () => "terminal-interrupt",
      },
    );
    assert.equal(result.doubleWriteControl.status, "fail");
    assert.equal(result.doubleWriteControl.accepted, 1);
    assert.equal(result.doubleWriteControl.explicitConflict, false);
    assert.deepEqual(result.approvalLifecycle, {
      status: "skipped",
      reason: "double-write gate failed",
    });
    assert.deepEqual(peers[0].outbound.filter(({ method }) => method === "thread/read").at(-1), {
      method: "thread/read",
      params: { threadId: "thread-marker", includeTurns: true },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live suite fails closed when a fulfilled race response has no interruptable turn id", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "projectboard-live-missing-turn-id-"));
  const peers = [new LiveSuitePeer("A"), new LiveSuitePeer("B")];
  let nextPeer = 0;
  const originalARequest = peers[0].request.bind(peers[0]);
  peers[0].request = async (method, params) => {
    if (method === "turn/start" && params.input) {
      peers[0].outbound.push({ method, params });
      return { turn: {} };
    }
    return originalARequest(method, params);
  };
  try {
    const error = await runLiveSuite(
      { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
      ["generated"],
      directory,
      async () => true,
      {
        consent: { allowPersistentThread: true, allowModelTurns: true },
        open: async () => {
          const peer = peers[nextPeer];
          nextPeer += 1;
          return { peer, close: async () => cleanClose() };
        },
        initialize: async () => ({}),
        readMarker: async () => true,
        uuid: () => "missing-turn-id",
      },
    ).catch((value) => value);
    assert.equal(error.code, "ELIVEINTERRUPT");
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].code, "ETURNIDENTITY");
    assert.equal(peers[0].outbound.some(({ method }) => method === "turn/interrupt"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
