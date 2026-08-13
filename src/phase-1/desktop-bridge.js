import { readEvaluationValue } from "../cdp/targets.js";
import { validateThreadSourceFilter } from "./catalog-policy.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGES = 1_000;
const ALLOWED_METHODS = new Set(["account/read", "thread/list"]);

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
}

function validateThread(thread) {
  const valid = thread
    && typeof thread === "object"
    && !Array.isArray(thread)
    && typeof thread.id === "string"
    && thread.id.length > 0
    && (thread.name === undefined || thread.name === null || typeof thread.name === "string")
    && typeof thread.preview === "string"
    && typeof thread.cwd === "string"
    && Number.isFinite(thread.createdAt)
    && Number.isFinite(thread.updatedAt)
    && thread.status
    && typeof thread.status === "object"
    && !Array.isArray(thread.status);
  if (!valid) throw new Error("desktop thread/list returned malformed thread metadata");
}

export function validateDesktopCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("desktop bridge returned a malformed catalog");
  }
  if (catalog.accountType !== null && catalog.accountType !== undefined && typeof catalog.accountType !== "string") {
    throw new Error("desktop bridge returned a malformed account identity");
  }
  if (typeof catalog.requiresOpenaiAuth !== "boolean") {
    throw new Error("desktop bridge returned a malformed authentication requirement");
  }
  if (!Array.isArray(catalog.activeThreads) || !Array.isArray(catalog.archivedThreads)) {
    throw new Error("desktop bridge returned malformed thread collections");
  }
  catalog.activeThreads.forEach(validateThread);
  catalog.archivedThreads.forEach(validateThread);
  if (!Array.isArray(catalog.outboundMethods)
    || catalog.outboundMethods.some((method) => !ALLOWED_METHODS.has(method))) {
    throw new Error("desktop bridge attempted a method outside the read-only allowlist");
  }
  if (catalog.outboundMethods.length < 3
    || catalog.outboundMethods[0] !== "account/read"
    || catalog.outboundMethods.slice(1).some((method) => method !== "thread/list")) {
    throw new Error("desktop bridge did not provide complete read-only request evidence");
  }
  return catalog;
}

export function buildDesktopCatalogExpression(sourceKinds, {
  hostId = "local",
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxPages = DEFAULT_MAX_PAGES,
} = {}) {
  validateThreadSourceFilter(sourceKinds);
  if (hostId !== "local") throw new TypeError("desktop bridge hostId must be local");
  positiveInteger(requestTimeoutMs, "requestTimeoutMs");
  positiveInteger(maxPages, "maxPages");
  const configuration = JSON.stringify({
    hostId,
    maxPages,
    requestTimeoutMs,
    sourceKinds: [...sourceKinds],
  });

  return `/*projectboard-phase1:desktop-readonly-catalog*/
(async () => {
  const configuration = ${configuration};
  const allowedMethods = new Set(["account/read", "thread/list"]);
  const bridge = globalThis.electronBridge;
  if (!bridge || typeof bridge.sendMessageFromView !== "function") {
    throw new Error("Codex desktop bridge is unavailable");
  }
  let sequence = 0;
  const outboundMethods = [];
  const request = (method, params) => {
    if (!allowedMethods.has(method)) throw new Error("Projectboard blocked a non-readonly desktop request");
    outboundMethods.push(method);
    sequence += 1;
    const id = Date.now() * 1000 + sequence;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        globalThis.clearTimeout(timer);
        globalThis.removeEventListener("message", onMessage);
      };
      const finish = (operation, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        operation(value);
      };
      const onMessage = (event) => {
        const message = event?.data;
        if (message?.type !== "mcp-response"
          || message.hostId !== configuration.hostId
          || message.message?.id !== id) return;
        const response = message.message;
        if (response.error) {
          const error = new Error(response.error.message || "Codex App Server request failed");
          error.rpc = response.error;
          finish(reject, error);
          return;
        }
        finish(resolve, response.result);
      };
      const timer = globalThis.setTimeout(
        () => finish(reject, new Error(method + " timed out")),
        configuration.requestTimeoutMs,
      );
      globalThis.addEventListener("message", onMessage);
      const source = method === "account/read" ? "account" : "thread";
      Promise.resolve(bridge.sendMessageFromView({
        type: "mcp-request",
        hostId: configuration.hostId,
        request: { id, method, params },
        priority: "interactive",
        source,
        timeoutMs: configuration.requestTimeoutMs,
        expiresAtMs: Date.now() + configuration.requestTimeoutMs,
      })).catch((error) => finish(reject, error));
    });
  };
  const metadataFrom = (thread) => {
    const valid = thread
      && typeof thread === "object"
      && !Array.isArray(thread)
      && typeof thread.id === "string"
      && thread.id.length > 0
      && (thread.name === undefined || thread.name === null || typeof thread.name === "string")
      && typeof thread.preview === "string"
      && typeof thread.cwd === "string"
      && Number.isFinite(thread.createdAt)
      && Number.isFinite(thread.updatedAt)
      && thread.status
      && typeof thread.status === "object"
      && !Array.isArray(thread.status);
    if (!valid) throw new Error("thread/list page contains malformed thread metadata");
    return {
      id: thread.id,
      name: thread.name ?? null,
      preview: thread.preview,
      cwd: thread.cwd,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: structuredClone(thread.status),
    };
  };
  const listAll = async (archived) => {
    const rows = [];
    const seenCursors = new Set();
    let cursor = null;
    for (let pageCount = 0; pageCount < configuration.maxPages; pageCount += 1) {
      const page = await request("thread/list", {
        archived,
        cursor,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: configuration.sourceKinds,
      });
      if (!page || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.data)) {
        throw new Error("thread/list returned a malformed page");
      }
      rows.push(...page.data.map(metadataFrom));
      const nextCursor = page.nextCursor ?? null;
      if (nextCursor === null) return rows;
      if (typeof nextCursor !== "string" || nextCursor.length === 0 || seenCursors.has(nextCursor)) {
        throw new Error("thread/list returned an invalid pagination cursor");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error("thread/list exceeded the pagination page limit");
  };
  const account = await request("account/read", { refreshToken: false });
  if (!account || typeof account !== "object" || typeof account.requiresOpenaiAuth !== "boolean") {
    throw new Error("account/read returned a malformed response");
  }
  if (account.account != null && (typeof account.account !== "object" || typeof account.account.type !== "string")) {
    throw new Error("account/read returned a malformed account identity");
  }
  const activeThreads = await listAll(false);
  const archivedThreads = await listAll(true);
  return {
    accountType: account.account?.type ?? null,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
    activeThreads,
    archivedThreads,
    outboundMethods,
  };
})()`;
}

export async function readDesktopThreadCatalog(peer, sessionId, sourceKinds, options = {}) {
  if (!peer || typeof peer.request !== "function") throw new TypeError("peer.request is required");
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId is required");
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const evaluationTimeoutMs = options.evaluationTimeoutMs ?? 60_000;
  positiveInteger(requestTimeoutMs, "requestTimeoutMs");
  positiveInteger(evaluationTimeoutMs, "evaluationTimeoutMs");
  const response = await peer.request("Runtime.evaluate", {
    expression: buildDesktopCatalogExpression(sourceKinds, options),
    awaitPromise: true,
    returnByValue: true,
  }, { sessionId, timeoutMs: evaluationTimeoutMs });
  const evaluated = readEvaluationValue(response);
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description
      ?? evaluated.exceptionDetails.text
      ?? "Codex desktop read-only bridge evaluation failed");
  }
  return validateDesktopCatalog(evaluated.value);
}
