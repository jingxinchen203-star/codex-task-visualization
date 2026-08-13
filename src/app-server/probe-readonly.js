import { prepareStagedCommand } from "../process/run-command.js";
import { JsonlPeer, initializeStable } from "./jsonl-peer.js";

const APP_SERVER_ARGUMENTS = Object.freeze(["app-server", "--listen", "stdio://"]);
export const DESKTOP_HOST_APP_SERVER_ARGUMENTS = Object.freeze([
  "-c",
  "features.code_mode_host=true",
  "app-server",
  "--analytics-default-enabled",
]);
const ALLOWED_APP_SERVER_ARGUMENTS = Object.freeze([
  APP_SERVER_ARGUMENTS,
  DESKTOP_HOST_APP_SERVER_ARGUMENTS,
]);
const DEFAULT_STDERR_BYTES = 64 * 1024;
const MAX_THREAD_LIST_PAGES = 1_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;

function safeError(error) {
  if (!error) return null;
  return Object.freeze({
    name: typeof error.name === "string" ? error.name : "Error",
    code: typeof error.code === "string" ? error.code : null,
    message: typeof error.message === "string" ? error.message : "Unknown error",
  });
}

async function settlementWithin(settlement, milliseconds) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve({ settled: false, value: null });
    }, milliseconds);
    settlement.then(
      (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ settled: true, value });
      },
      (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ settled: true, value: { code: null, signal: null, error, unsettled: true } });
      },
    );
  });
}

function boundedBytes(limit) {
  const chunks = [];
  let kept = 0;
  let total = 0;
  let streamError = null;
  return {
    add(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      const available = Math.max(0, limit - kept);
      if (available > 0) {
        const slice = bytes.subarray(0, available);
        chunks.push(slice);
        kept += slice.length;
      }
    },
    fail(error) { streamError ??= error; },
    value() {
      return Object.freeze({
        text: Buffer.concat(chunks).toString("utf8"),
        bytes: total,
        truncated: total > kept,
        ...(streamError ? { error: { name: streamError.name, code: streamError.code ?? null, message: streamError.message } } : {}),
      });
    },
  };
}

function launchRecipe(candidate) {
  const recipe = candidate?.launchRecipe ?? candidate;
  if (!recipe || typeof recipe !== "object" || recipe.kind !== "private-staged-snapshot") {
    throw new TypeError("a private staged launch recipe is required");
  }
  return recipe;
}

function fixedAppServerArguments(value) {
  if (!Array.isArray(value) || value.some((argument) => typeof argument !== "string")) {
    throw new TypeError("appServerArguments must be a fixed read-only launch recipe");
  }
  const allowed = ALLOWED_APP_SERVER_ARGUMENTS.find((recipe) => (
    recipe.length === value.length && recipe.every((argument, index) => argument === value[index])
  ));
  if (!allowed) throw new TypeError("appServerArguments must be a fixed read-only launch recipe");
  return allowed;
}

async function disposeAfterFailedSpawn(resource, primaryError) {
  try {
    await resource.dispose();
  } catch (cleanupError) {
    primaryError.cleanupError = cleanupError;
  }
  throw primaryError;
}

export async function openAppServer(candidate, {
  prepare = prepareStagedCommand,
  prepareTimeoutMs = 15_000,
  signal,
  cwd,
  maxStderrBytes = DEFAULT_STDERR_BYTES,
  shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  appServerArguments = APP_SERVER_ARGUMENTS,
} = {}) {
  if (!Number.isInteger(maxStderrBytes) || maxStderrBytes < 0) throw new TypeError("maxStderrBytes must be a nonnegative integer");
  if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 0) throw new TypeError("shutdownGraceMs must be a nonnegative integer");
  const fixedArguments = fixedAppServerArguments(appServerArguments);
  const prepareOptions = { timeoutMs: prepareTimeoutMs };
  if (signal !== undefined) prepareOptions.signal = signal;
  if (cwd !== undefined) prepareOptions.cwd = cwd;
  const resource = await prepare(launchRecipe(candidate), prepareOptions);

  let child;
  try {
    child = await resource.spawn([...fixedArguments]);
  } catch (error) {
    return disposeAfterFailedSpawn(resource, error);
  }

  const stderr = boundedBytes(maxStderrBytes);
  let settleStderr;
  const stderrDone = new Promise((resolve) => { settleStderr = resolve; });
  if (child.stderr) {
    child.stderr.on("data", (chunk) => stderr.add(chunk));
    child.stderr.on("error", (error) => { stderr.fail(error); settleStderr(); });
    child.stderr.on("end", settleStderr);
    child.stderr.on("close", settleStderr);
    if (child.stderr.readableEnded || child.stderr.destroyed) settleStderr();
  } else {
    settleStderr();
  }
  let peer;
  try {
    peer = new JsonlPeer(child.stdout, child.stdin);
  } catch (error) {
    try { await child.terminate(); } catch (terminationError) { error.terminationError = terminationError; }
    try { await child.settlement; } catch (settlementError) { error.settlementError = settlementError; }
    try { await resource.dispose(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }

  let closePromise = null;
  let deferredCleanupPromise = null;
  const scheduleDeferredCleanup = () => {
    deferredCleanupPromise ??= (async () => {
      let settlement;
      try {
        settlement = await child.settlement;
      } catch (error) {
        return Object.freeze({
          settlement: Object.freeze({ code: null, signal: null, error: safeError(error), unsettled: true }),
          disposal: null,
          stderr: stderr.value(),
          cleanup: Object.freeze({ attempted: false, deferred: false, retained: true, ok: false, error: safeError(error) }),
        });
      }
      if (!settlement || settlement.unsettled !== false) {
        return Object.freeze({
          settlement,
          disposal: null,
          stderr: stderr.value(),
          cleanup: Object.freeze({
            attempted: false,
            deferred: false,
            retained: true,
            ok: false,
            error: safeError(Object.assign(new Error("Final child settlement remained unsettled"), { code: "ECHILDUNSETTLED" })),
          }),
        });
      }
      await stderrDone;
      try {
        const disposal = await resource.dispose();
        return Object.freeze({ settlement, disposal, stderr: stderr.value(), cleanup: disposal.cleanup });
      } catch (error) {
        return Object.freeze({
          settlement,
          disposal: null,
          stderr: stderr.value(),
          cleanup: Object.freeze({ attempted: true, deferred: false, retained: true, ok: false, error: safeError(error) }),
        });
      }
    })();
    return deferredCleanupPromise;
  };
  const close = () => {
    closePromise ??= (async () => {
      let gracefulError = null;
      try {
        if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      } catch (error) {
        gracefulError = error;
      }

      let terminationError = null;
      let settled = gracefulError ? { settled: false, value: null } : await settlementWithin(child.settlement, shutdownGraceMs);
      if (!settled.settled) {
        try {
          await child.terminate();
        } catch (error) {
          terminationError = error;
        }
        settled = await settlementWithin(child.settlement, shutdownGraceMs);
      }

      let settlement;
      if (!settled.settled) {
        const error = Object.assign(new Error("Owned App Server child did not settle after graceful and forced shutdown"), { code: "ECHILDUNSETTLED" });
        error.lifecycle = Object.freeze({
          settled: false,
          code: null,
          signal: null,
          error: null,
          unsettled: true,
          gracefulError: safeError(gracefulError),
          terminationError: safeError(terminationError),
          stderrBytes: stderr.value().bytes,
          stderrTruncated: stderr.value().truncated,
          cleanup: Object.freeze({ attempted: false, deferred: true, retained: true, ok: false, error: null }),
        });
        error.deferredCleanup = scheduleDeferredCleanup();
        throw error;
      }
      settlement = settled.value;
      await stderrDone;

      let disposal;
      try {
        disposal = await resource.dispose();
      } catch (error) {
        error.lifecycle = { terminationError, settlement, stderr: stderr.value() };
        throw error;
      }
      return Object.freeze({
        settlement,
        disposal,
        stderr: stderr.value(),
        terminationError: safeError(terminationError),
      });
    })();
    return closePromise;
  };

  return Object.freeze({
    peer,
    execution: resource.execution,
    binding: resource.binding,
    settlement: child.settlement,
    close,
  });
}

function validateSourceKinds(sourceKinds) {
  const valid = Array.isArray(sourceKinds)
    && sourceKinds.every((value) => typeof value === "string" && value.length > 0)
    && new Set(sourceKinds).size === sourceKinds.length;
  if (!valid) throw new TypeError("sourceKinds must contain unique nonempty strings when supplied");
}

function metadataFrom(thread) {
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
}

export async function listAllThreadMetadata(peer, archived, sourceKinds) {
  if (!peer || typeof peer.request !== "function") throw new TypeError("peer.request is required");
  if (typeof archived !== "boolean") throw new TypeError("archived must be a boolean");
  validateSourceKinds(sourceKinds);
  const generatedKinds = [...sourceKinds];
  const rows = [];
  const seenCursors = new Set();
  let cursor = null;
  let pageCount = 0;

  while (true) {
    if (pageCount >= MAX_THREAD_LIST_PAGES) throw new Error("thread/list exceeded the pagination page limit");
    pageCount += 1;
    const page = await peer.request("thread/list", {
      archived,
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: generatedKinds,
    });
    if (!page || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.data)) {
      throw new Error("thread/list returned a malformed page");
    }
    rows.push(...page.data.map(metadataFrom));
    const nextCursor = page.nextCursor ?? null;
    if (nextCursor === null) break;
    if (typeof nextCursor !== "string" || nextCursor.length === 0) {
      throw new Error("thread/list returned a malformed pagination cursor");
    }
    if (seenCursors.has(nextCursor)) throw new Error("thread/list repeated a pagination cursor");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return rows;
}

function publicLifecycle(outcome) {
  const terminationError = safeError(outcome?.terminationError ?? outcome?.settlement?.termination?.error);
  return {
    code: outcome?.settlement?.code ?? null,
    signal: outcome?.settlement?.signal ?? null,
    ...(terminationError ? { terminationError } : {}),
    stderrBytes: outcome?.stderr?.bytes ?? 0,
    stderrTruncated: outcome?.stderr?.truncated ?? false,
    cleanupOk: outcome?.disposal?.cleanup?.ok === true,
  };
}

function lifecycleEvidence(outcome) {
  const settlement = outcome?.settlement;
  const cleanup = outcome?.disposal?.cleanup ?? outcome?.cleanup;
  return Object.freeze({
    settled: Boolean(settlement && settlement.unsettled === false),
    code: settlement?.code ?? null,
    signal: settlement?.signal ?? null,
    unsettled: settlement?.unsettled ?? true,
    settlementError: safeError(settlement?.error),
    terminationError: safeError(outcome?.terminationError ?? settlement?.termination?.error),
    terminationGraceExpired: settlement?.termination?.graceExpired === true,
    cleanupOk: cleanup?.ok === true,
    cleanupError: safeError(cleanup?.error),
    cleanupDeferred: cleanup?.deferred === true,
    cleanupRetained: cleanup?.retained === true,
    stderrBytes: outcome?.stderr?.bytes ?? 0,
    stderrTruncated: outcome?.stderr?.truncated ?? false,
    stderrError: safeError(outcome?.stderr?.error),
  });
}

function lifecycleEvidenceFromError(error) {
  const lifecycle = error?.lifecycle;
  if (lifecycle?.settlement || lifecycle?.disposal) return lifecycleEvidence(lifecycle);
  const cleanup = lifecycle?.cleanup;
  return Object.freeze({
    settled: lifecycle?.settled === true,
    code: lifecycle?.code ?? null,
    signal: lifecycle?.signal ?? null,
    unsettled: lifecycle?.unsettled ?? true,
    settlementError: safeError(lifecycle?.settlementError ?? lifecycle?.error),
    terminationError: safeError(lifecycle?.terminationError),
    terminationGraceExpired: lifecycle?.terminationGraceExpired === true,
    cleanupOk: lifecycle?.cleanupOk === true || cleanup?.ok === true,
    cleanupError: safeError(lifecycle?.cleanupError ?? cleanup?.error),
    cleanupDeferred: lifecycle?.cleanupDeferred === true || cleanup?.deferred === true,
    cleanupRetained: lifecycle?.cleanupRetained === true || cleanup?.retained === true,
    stderrBytes: lifecycle?.stderrBytes ?? lifecycle?.stderr?.bytes ?? 0,
    stderrTruncated: lifecycle?.stderrTruncated ?? lifecycle?.stderr?.truncated ?? false,
    stderrError: safeError(lifecycle?.stderrError ?? lifecycle?.stderr?.error),
  });
}

function lifecycleError(evidence, code = "EAPPSERVERLIFECYCLE") {
  const error = Object.assign(new Error("App Server close lifecycle validation failed"), { code });
  error.lifecycle = evidence;
  return error;
}

function validateCloseLifecycle(outcome) {
  const settlement = outcome?.settlement;
  const cleanup = outcome?.disposal?.cleanup;
  const healthy = settlement
    && settlement.unsettled === false
    && settlement.code === 0
    && settlement.signal === null
    && settlement.error === null
    && cleanup?.ok === true
    && !cleanup.error
    && !outcome?.stderr?.error;
  if (!healthy) throw lifecycleError(lifecycleEvidence(outcome));
}

function normalizeCloseError(error) {
  const normalized = lifecycleError(
    lifecycleEvidenceFromError(error),
    error?.code === "ECHILDUNSETTLED" ? "ECHILDUNSETTLED" : "EAPPSERVERLIFECYCLE",
  );
  if (error?.deferredCleanup?.then) {
    normalized.deferredCleanup = error.deferredCleanup.then((outcome) => lifecycleEvidence(outcome));
  }
  return normalized;
}

export async function probeAppServerIdentity(candidate, sourceKinds, options = {}) {
  validateSourceKinds(sourceKinds);
  const { open = openAppServer, ...openOptions } = options;
  const handle = await open(candidate, openOptions);
  let result;
  let primaryError = null;
  try {
    await initializeStable(handle.peer);
    const account = await handle.peer.request("account/read", { refreshToken: false });
    if (!account || typeof account !== "object" || typeof account.requiresOpenaiAuth !== "boolean") {
      throw new Error("account/read returned a malformed response");
    }
    if (account.account !== null && account.account !== undefined
      && (!account.account || typeof account.account !== "object" || typeof account.account.type !== "string")) {
      throw new Error("account/read returned a malformed account identity");
    }
    const active = await listAllThreadMetadata(handle.peer, false, sourceKinds);
    const archived = await listAllThreadMetadata(handle.peer, true, sourceKinds);
    result = {
      initialized: true,
      accountType: account.account?.type ?? null,
      requiresOpenaiAuth: account.requiresOpenaiAuth,
      activeCount: active.length,
      archivedCount: archived.length,
      outboundMethods: handle.peer.outbound.map(({ method }) => method).filter((method) => typeof method === "string"),
    };
  } catch (error) {
    primaryError = error;
  }

  let closeOutcome;
  let closeFailure = null;
  try {
    closeOutcome = await handle.close();
  } catch (closeError) {
    closeFailure = normalizeCloseError(closeError);
  }
  if (!closeFailure) {
    try {
      validateCloseLifecycle(closeOutcome);
    } catch (error) {
      closeFailure = error;
    }
  }
  if (closeFailure) {
    if (!primaryError) throw closeFailure;
    primaryError.closeError = closeFailure;
    primaryError.lifecycle = closeFailure.lifecycle;
    if (closeFailure.deferredCleanup) primaryError.deferredCleanup = closeFailure.deferredCleanup;
  }
  if (primaryError) {
    if (!primaryError.lifecycle && closeOutcome) primaryError.lifecycle = publicLifecycle(closeOutcome);
    throw primaryError;
  }
  return Object.freeze({ ...result, lifecycle: publicLifecycle(closeOutcome) });
}
