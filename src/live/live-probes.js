import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { ApprovalStore, digestApproval } from "../approvals/approval-store.js";
import { initializeStable } from "../app-server/jsonl-peer.js";
import { openAppServer } from "../app-server/probe-readonly.js";

const ACTIVE_TURN_CONFLICTS = new Map([
  [-32000, new Set(["activeTurn"])],
]);

export function validateLiveConsent(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("live consent options must be an object");
  }
  const { allowPersistentThread, allowModelTurns } = options;
  if (typeof allowPersistentThread !== "boolean" || typeof allowModelTurns !== "boolean") {
    throw new TypeError("live consent flags must be boolean");
  }
  if (!allowPersistentThread && !allowModelTurns) {
    throw new Error("live probes require explicit persistent thread and model turns consent");
  }
  if (!allowPersistentThread) throw new Error("model turns require persistent thread consent");
  if (!allowModelTurns) throw new Error("persistent thread probe requires model turns consent");
  return Object.freeze({ persistentThreads: 1, modelTurns: 2, approvals: "decline-only" });
}

function explicitConflict(result) {
  const rpc = result?.status === "rejected" ? result.reason?.rpc : null;
  const reason = rpc?.data?.reason;
  if (!rpc || !Number.isInteger(rpc.code) || typeof reason !== "string"
    || !ACTIVE_TURN_CONFLICTS.get(rpc.code)?.has(reason)) {
    return null;
  }
  return Object.freeze({ code: rpc.code, reason });
}

export function evaluateStartRace(results) {
  if (!Array.isArray(results) || results.length !== 2) {
    throw new TypeError("double-start evaluation requires exactly two results");
  }
  const fulfilled = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => result?.status === "fulfilled");
  const rejected = results.filter((result) => result?.status === "rejected");
  const acceptedEntry = fulfilled.length === 1 ? fulfilled[0] : null;
  const acceptedTurnId = acceptedEntry?.result?.value?.turn?.id;
  const conflict = rejected.length === 1 ? explicitConflict(rejected[0]) : null;
  const acceptedValid = typeof acceptedTurnId === "string" && acceptedTurnId.length > 0;
  const passed = fulfilled.length === 1 && rejected.length === 1 && acceptedValid && conflict !== null;
  return Object.freeze({
    status: passed ? "pass" : "fail",
    accepted: fulfilled.length,
    explicitConflict: conflict !== null,
    acceptedIndex: acceptedEntry?.index ?? null,
    acceptedTurnId: acceptedValid ? acceptedTurnId : null,
    conflict,
  });
}

function requirePeer(peer, label) {
  if (!peer || typeof peer.request !== "function") throw new TypeError(`${label}.request is required`);
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

export async function createVisibilityMarker(peer, cwd, { uuid = randomUUID } = {}) {
  requirePeer(peer, "peer");
  requireText(cwd, "cwd");
  if (typeof uuid !== "function") throw new TypeError("uuid must be a function");
  const markerId = requireText(uuid(), "marker id");
  const marker = `[Projectboard Phase 0] ${markerId}`;
  const started = await peer.request("thread/start", {
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "projectboard_phase0",
  });
  const threadId = started?.thread?.id;
  requireText(threadId, "thread/start thread id");
  await peer.request("thread/name/set", { threadId, name: marker });
  return Object.freeze({ threadId, marker });
}

function dispatchRequest(peer, method, params) {
  try {
    return Promise.resolve(peer.request(method, params));
  } catch (error) {
    return Promise.reject(error);
  }
}

const TERMINAL_TURN_STATUSES = new Set(["completed", "interrupted", "failed"]);

async function hasTerminalTurn(peer, threadId, turnId) {
  try {
    const read = await dispatchRequest(peer, "thread/read", {
      threadId,
      includeTurns: true,
    });
    return read?.thread?.id === threadId
      && Array.isArray(read.thread.turns)
      && read.thread.turns.some((turn) => (
        turn?.id === turnId && TERMINAL_TURN_STATUSES.has(turn.status)
      ));
  } catch {
    return false;
  }
}

export function raceTurnStart(peerA, peerB, threadId) {
  requirePeer(peerA, "peerA");
  requirePeer(peerB, "peerB");
  requireText(threadId, "threadId");
  const params = (answer) => ({
    threadId,
    input: [{ type: "text", text: `Reply with exactly ${answer} and do not use tools.` }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
  });
  const first = dispatchRequest(peerA, "turn/start", params("A"));
  const second = dispatchRequest(peerB, "turn/start", params("B"));
  return Promise.allSettled([first, second]);
}

function eventWait(emitter, event, predicate, timeoutMs, { historyOffset = 0 } = {}) {
  const history = event === "serverRequest" ? emitter.serverRequests : emitter.notifications;
  const existing = Array.isArray(history) ? history.slice(historyOffset).find(predicate) : undefined;
  if (existing !== undefined) {
    return { promise: Promise.resolve(existing), cancel() {} };
  }
  let settled = false;
  let rejectWait;
  let timer;
  const listener = (value) => {
    if (settled || !predicate(value)) return;
    settled = true;
    clearTimeout(timer);
    emitter.off(event, listener);
    resolveWait(value);
  };
  let resolveWait;
  const promise = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      emitter.off(event, listener);
      reject(Object.assign(new Error(`${event} timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    emitter.on(event, listener);
  });
  return {
    promise,
    cancel(error = Object.assign(new Error(`${event} wait cancelled`), { code: "ECANCELLED" })) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      emitter.off(event, listener);
      rejectWait(error);
    },
  };
}

function validMessageId(value) {
  return (typeof value === "string" && value.length > 0) || Number.isSafeInteger(value);
}

function approvalRequest(message, instanceId) {
  const params = message?.params;
  if (!validMessageId(message?.id) || !params || typeof params !== "object" || Array.isArray(params)) {
    throw Object.assign(new Error("approval request is malformed"), { code: "EAPPROVALMESSAGE" });
  }
  return {
    instanceId,
    requestId: message.id,
    requestMethod: message.method,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    command: params.command ?? null,
    cwd: params.cwd ?? null,
    scope: {
      network: params.networkApprovalContext ?? null,
      additionalPermissions: params.additionalPermissions ?? null,
      grantRoot: params.grantRoot ?? null,
    },
  };
}

async function defaultExists(filePath) {
  return access(filePath).then(() => true, () => false);
}

export async function runDeclineOnlyApprovalProbe(peer, {
  instanceId,
  threadId,
  markerPath,
  approvalStore,
  displayApproval = async () => {},
  now = Date.now,
  exists = defaultExists,
  eventTimeoutMs = 15_000,
  approvalTtlMs = 30_000,
} = {}) {
  requirePeer(peer, "peer");
  if (typeof peer.respond !== "function" || typeof peer.on !== "function" || typeof peer.off !== "function") {
    throw new TypeError("peer must support response and event methods");
  }
  requireText(instanceId, "instanceId");
  requireText(threadId, "threadId");
  requireText(markerPath, "markerPath");
  if (!approvalStore || typeof approvalStore.add !== "function" || typeof approvalStore.respond !== "function") {
    throw new TypeError("approvalStore is required");
  }
  if (typeof displayApproval !== "function" || typeof now !== "function" || typeof exists !== "function") {
    throw new TypeError("displayApproval, now, and exists must be functions");
  }
  if (!Number.isInteger(eventTimeoutMs) || eventTimeoutMs <= 0) throw new TypeError("eventTimeoutMs must be positive");
  if (!Number.isInteger(approvalTtlMs) || approvalTtlMs <= 0) throw new TypeError("approvalTtlMs must be positive");

  const allowedMethods = new Set([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ]);
  const requestHistoryOffset = Array.isArray(peer.serverRequests) ? peer.serverRequests.length : 0;
  const isApprovalForThread = (message) => (
    allowedMethods.has(message?.method) && message.params?.threadId === threadId
  );
  const approvalWait = eventWait(
    peer,
    "serverRequest",
    isApprovalForThread,
    eventTimeoutMs,
    { historyOffset: requestHistoryOffset },
  );
  const cancelAndInterruptFreshApproval = async (primaryError) => {
    const capturedApproval = Array.isArray(peer.serverRequests)
      ? peer.serverRequests.slice(requestHistoryOffset).find(isApprovalForThread)
      : null;
    approvalWait.cancel(primaryError);
    await approvalWait.promise.catch(() => {});
    const evidencedTurnId = capturedApproval?.params?.turnId;
    if (typeof evidencedTurnId !== "string" || evidencedTurnId.length === 0) return;
    try {
      await peer.request("turn/interrupt", { threadId, turnId: evidencedTurnId });
    } catch (interruptError) {
      primaryError.interruptError = Object.assign(
        new Error("approval probe could not interrupt its evidenced turn", { cause: interruptError }),
        { code: "EAPPROVALINTERRUPT" },
      );
    }
  };
  let started;
  try {
    started = await peer.request("turn/start", {
      threadId,
      input: [{
        type: "text",
        text: `Attempt exactly one PowerShell command that writes the word probe to ${markerPath}. Do not use another path.`,
      }],
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly" },
    });
  } catch (error) {
    await cancelAndInterruptFreshApproval(error);
    throw error;
  }

  const startedTurnId = started?.turn?.id;
  if (typeof startedTurnId !== "string" || startedTurnId.length === 0) {
    const error = Object.assign(new Error("turn/start returned a malformed turn identity"), {
      code: "EAPPROVALMESSAGE",
    });
    await cancelAndInterruptFreshApproval(error);
    throw error;
  }
  let needsInterrupt = true;
  const interrupt = async () => {
    if (!needsInterrupt) return false;
    needsInterrupt = false;
    try {
      await peer.request("turn/interrupt", { threadId, turnId: startedTurnId });
      return true;
    } catch (cause) {
      if (await hasTerminalTurn(peer, threadId, startedTurnId)) return false;
      throw Object.assign(new Error("approval probe could not interrupt its turn", { cause }), {
        code: "EAPPROVALINTERRUPT",
      });
    }
  };

  try {
    let approval;
    const completionWait = eventWait(peer, "notification", (message) => (
      message?.method === "turn/completed" && message.params?.turn?.id === startedTurnId
    ), eventTimeoutMs);
    try {
      const outcome = await Promise.race([
        approvalWait.promise.then((value) => ({ kind: "approval", value })),
        completionWait.promise.then((value) => ({ kind: "completion", value })),
      ]);
      if (outcome.kind === "completion") {
        approvalWait.cancel();
        await approvalWait.promise.catch(() => {});
        needsInterrupt = false;
        return Object.freeze({
          status: "inconclusive",
          reason: "turn completed without approval request",
          interrupted: false,
        });
      }
      completionWait.cancel();
      await completionWait.promise.catch(() => {});
      approval = outcome.value;
    } catch (error) {
      approvalWait.cancel(error);
      completionWait.cancel(error);
      await Promise.allSettled([approvalWait.promise, completionWait.promise]);
      if (error?.code !== "ETIMEDOUT") throw error;
      const interrupted = await interrupt();
      return Object.freeze({
        status: "inconclusive",
        reason: interrupted ? "no approval request" : "turn completed without approval request",
        interrupted,
      });
    }
    if (approval?.params?.turnId !== startedTurnId) {
      throw Object.assign(new Error("approval request turn identity changed"), { code: "EAPPROVALMESSAGE" });
    }

    const request = approvalRequest(approval, instanceId);
    const currentTime = now();
    if (!Number.isSafeInteger(currentTime) || currentTime < 0
      || !Number.isSafeInteger(currentTime + approvalTtlMs)) {
      throw Object.assign(new Error("approval clock is invalid"), { code: "EAPPROVALCLOCK" });
    }
    const digest = digestApproval(request);
    approvalStore.add(request, currentTime + approvalTtlMs);
    await displayApproval(Object.freeze({
      requestId: approval.id,
      requestMethod: request.requestMethod,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      command: request.command,
      cwd: request.cwd,
      scope: Object.freeze({ ...request.scope }),
      digest,
      fixedDecision: "decline",
    }));
    const decision = approvalStore.respond({
      requestId: approval.id,
      responder: "human-ui",
      instanceId,
      digest,
      decision: "decline",
    });

    const waits = [
      eventWait(peer, "notification", (message) => (
        message?.method === "serverRequest/resolved"
        && String(message.params?.requestId) === String(approval.id)
      ), eventTimeoutMs),
      eventWait(peer, "notification", (message) => (
        message?.method === "item/completed" && message.params?.item?.id === request.itemId
      ), eventTimeoutMs),
      eventWait(peer, "notification", (message) => (
        message?.method === "turn/completed" && message.params?.turn?.id === request.turnId
      ), eventTimeoutMs),
    ];
    let completed;
    try {
      await peer.respond(approval.id, { decision: decision.decision });
      completed = await Promise.all(waits.map(({ promise }) => promise));
    } catch (error) {
      for (const wait of waits) wait.cancel(error);
      await Promise.allSettled(waits.map(({ promise }) => promise));
      throw error;
    }
    needsInterrupt = false;

    const itemStatus = completed[1]?.params?.item?.status;
    const markerAbsent = !(await exists(markerPath));
    return Object.freeze({
      status: markerAbsent && itemStatus === "declined" ? "pass" : "fail",
      requestMethod: approval.method,
      requestId: approval.id,
      decision: "decline",
      markerAbsent,
      itemStatus: typeof itemStatus === "string" ? itemStatus : null,
    });
  } catch (error) {
    if (needsInterrupt) {
      try {
        await interrupt();
      } catch (interruptError) {
        error.interruptError = interruptError;
      }
    }
    throw error;
  }
}

function healthyClose(outcome) {
  return outcome?.settlement?.unsettled === false
    && outcome.settlement.code === 0
    && outcome.settlement.signal === null
    && outcome.settlement.error === null
    && outcome?.disposal?.cleanup?.ok === true
    && !outcome.disposal.cleanup.error
    && !outcome?.stderr?.error;
}

function closeFailure(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: "ELIVECLEANUP" });
}

async function closeHandles(handles) {
  const attempts = handles.map((handle) => {
    try {
      if (!handle || typeof handle.close !== "function") throw new TypeError("owned live handle.close is required");
      return Promise.resolve(handle.close());
    } catch (error) {
      return Promise.reject(error);
    }
  });
  const settled = await Promise.allSettled(attempts);
  const errors = [];
  for (const result of settled) {
    if (result.status === "rejected") errors.push(closeFailure("live App Server close failed", result.reason));
    else if (!healthyClose(result.value)) errors.push(closeFailure("live App Server close lifecycle was unhealthy"));
  }
  return errors;
}

async function interruptAcceptedTurns(targets, threadId) {
  const attempts = targets.map(({ peer, turnId }) => (
    typeof turnId === "string" && turnId.length > 0
      ? dispatchRequest(peer, "turn/interrupt", { threadId, turnId })
      : Promise.reject(Object.assign(new Error("fulfilled turn/start response has no turn identity"), {
        code: "ETURNIDENTITY",
      }))
  ));
  const settled = await Promise.allSettled(attempts);
  const errors = [];
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status !== "rejected") continue;
    const target = targets[index];
    const terminal = typeof target.turnId === "string" && target.turnId.length > 0
      ? await hasTerminalTurn(target.peer, threadId, target.turnId)
      : false;
    if (terminal) continue;
    errors.push(Object.assign(new Error("accepted turn interrupt failed", { cause: outcome.reason }), {
      code: outcome.reason?.code ?? "EINTERRUPT",
      turnId: target.turnId,
    }));
  }
  if (errors.length > 0) {
    throw Object.assign(new AggregateError(errors, "one or more accepted turns could not be interrupted"), {
      code: "ELIVEINTERRUPT",
    });
  }
}

function validateSourceKinds(sourceKinds) {
  const valid = Array.isArray(sourceKinds)
    && sourceKinds.length > 0
    && sourceKinds.every((value) => typeof value === "string" && value.length > 0)
    && new Set(sourceKinds).size === sourceKinds.length;
  if (!valid) throw new TypeError("sourceKinds must be a nonempty generated array of unique strings");
}

async function readVisibilityMarker(peer, marker) {
  const response = await peer.request("thread/read", {
    threadId: marker.threadId,
    includeTurns: true,
  });
  const thread = response?.thread;
  return Boolean(
    thread
    && thread.id === marker.threadId
    && thread.name === marker.marker
    && thread.ephemeral === false
    && Array.isArray(thread.turns)
    && thread.turns.length === 0
  );
}

function validateExistingMarker(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    throw new TypeError("existingMarker must be a marker object");
  }
  const threadId = requireText(marker.threadId, "existingMarker.threadId");
  const name = requireText(marker.marker, "existingMarker.marker");
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const prefix = "[Projectboard Phase 0] ";
  if (!uuidPattern.test(threadId)) {
    throw new TypeError("existingMarker.threadId must be a UUID");
  }
  if (!name.startsWith(prefix) || !uuidPattern.test(name.slice(prefix.length))) {
    throw new TypeError("existingMarker.marker must be a Phase 0 marker name");
  }
  return Object.freeze({ threadId, marker: name });
}

export async function runLiveSuite(candidate, sourceKinds, fixtureCwd, confirmDesktop, {
  consent,
  existingMarker = null,
  open = openAppServer,
  initialize = initializeStable,
  readMarker = readVisibilityMarker,
  approvalProbe = runDeclineOnlyApprovalProbe,
  mkdirImpl = mkdir,
  databaseFactory = (file) => new DatabaseSync(file),
  displayApproval = async () => {},
  uuid = randomUUID,
  eventTimeoutMs = 15_000,
} = {}) {
  const quota = validateLiveConsent(consent);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError("candidate is required");
  validateSourceKinds(sourceKinds);
  requireText(fixtureCwd, "fixtureCwd");
  if (!path.isAbsolute(fixtureCwd)) throw new TypeError("fixtureCwd must be absolute");
  if (typeof confirmDesktop !== "function") throw new TypeError("confirmDesktop must be a function");
  for (const [name, dependency] of Object.entries({
    open,
    initialize,
    readMarker,
    approvalProbe,
    mkdirImpl,
    databaseFactory,
    displayApproval,
    uuid,
  })) {
    if (typeof dependency !== "function") throw new TypeError(`${name} must be a function`);
  }
  if (!Number.isInteger(eventTimeoutMs) || eventTimeoutMs <= 0) throw new TypeError("eventTimeoutMs must be positive");
  const resumedMarker = existingMarker === null ? null : validateExistingMarker(existingMarker);

  const handles = [];
  let approvalDatabase = null;
  let primaryError = null;
  let result = null;
  try {
    await mkdirImpl(fixtureCwd, { recursive: true });
    handles.push(await open(candidate));
    handles.push(await open(candidate));
    await Promise.all(handles.map(({ peer }) => initialize(peer)));
    approvalDatabase = databaseFactory(path.join(fixtureCwd, "phase0-approvals.sqlite"));
    const approvalStore = new ApprovalStore(approvalDatabase);

    const marker = resumedMarker ?? await createVisibilityMarker(handles[0].peer, fixtureCwd, { uuid });
    const visible = await readMarker(handles[1].peer, marker);
    const desktopConfirmed = visible ? await confirmDesktop(marker) === true : false;
    const appServerIdentity = Object.freeze({
      status: visible && desktopConfirmed ? "pass" : "inconclusive",
      visibleAcrossProcesses: visible,
      desktopConfirmed,
    });

    let doubleWriteControl = Object.freeze({
      status: "skipped",
      accepted: 0,
      explicitConflict: false,
      acceptedIndex: null,
      acceptedTurnId: null,
      conflict: null,
    });
    let approvalLifecycle = Object.freeze({ status: "skipped", reason: "App Server identity was not confirmed" });
    if (appServerIdentity.status === "pass") {
      await handles[1].peer.request("thread/resume", { threadId: marker.threadId });
      const raced = await raceTurnStart(handles[0].peer, handles[1].peer, marker.threadId);
      doubleWriteControl = evaluateStartRace(raced);
      if (doubleWriteControl.status === "pass") {
        const winner = handles[doubleWriteControl.acceptedIndex].peer;
        try {
          await eventWait(
            winner,
            "notification",
            (message) => (
              message?.method === "turn/completed"
              && message.params?.turn?.id === doubleWriteControl.acceptedTurnId
            ),
            eventTimeoutMs,
          ).promise;
        } catch (error) {
          try {
            await interruptAcceptedTurns([{
              peer: winner,
              turnId: doubleWriteControl.acceptedTurnId,
            }], marker.threadId);
          } catch (interruptError) {
            error.interruptError = interruptError;
          }
          throw error;
        }
        approvalLifecycle = await approvalProbe(winner, {
          instanceId: `phase0-${marker.threadId}`,
          threadId: marker.threadId,
          markerPath: path.join(fixtureCwd, `approval-marker-${uuid()}.txt`),
          approvalStore,
          displayApproval,
          eventTimeoutMs,
        });
      } else {
        const interrupts = raced.map((entry, index) => {
          if (entry?.status !== "fulfilled") return null;
          const turnId = entry.value?.turn?.id;
          return {
            peer: handles[index].peer,
            turnId: typeof turnId === "string" && turnId.length > 0 ? turnId : null,
          };
        }).filter(Boolean);
        await interruptAcceptedTurns(interrupts, marker.threadId);
        approvalLifecycle = Object.freeze({ status: "skipped", reason: "double-write gate failed" });
      }
    }

    result = Object.freeze({
      quota,
      marker,
      appServerIdentity,
      doubleWriteControl,
      approvalLifecycle,
    });
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (approvalDatabase) {
    try { approvalDatabase.close(); } catch (error) { cleanupErrors.push(closeFailure("approval database close failed", error)); }
  }
  cleanupErrors.push(...await closeHandles(handles));
  if (primaryError) {
    if (cleanupErrors.length > 0) primaryError.cleanupErrors = Object.freeze(cleanupErrors);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "live suite cleanup failed");
  return result;
}
