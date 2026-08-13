import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { CdpPipePeer } from "../cdp/pipe-peer.js";
import {
  buildFrameExpression,
  readEvaluationValue,
  selectCodexTargets,
} from "../cdp/targets.js";
import { validateThreadSourceFilter } from "./catalog-policy.js";
import { readDesktopThreadCatalog } from "./desktop-bridge.js";
import { buildStaticEmbeddedBoardDocument } from "./embedded-board.js";
import {
  LOCAL_BOARD_LANES,
  loadLaneOverrides,
  persistLaneOverrides,
  upsertLaneOverride,
} from "./lane-overrides.js";
import { buildBoundReadonlyBoardSnapshot } from "./service.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TARGET_DEADLINE_MS = 30_000;
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_INTERACTION_INTERVAL_MS = 1_000;
const DEFAULT_INTERACTION_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REFRESH_BACKOFF_MS = 5 * 60_000;
const MAX_STDERR_BYTES = 64 * 1024;

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
}

function emitSafely(emitter, eventName, ...args) {
  for (const listener of emitter.rawListeners(eventName)) {
    try {
      Reflect.apply(listener, emitter, args);
    } catch {
      // Host event listeners are observers and cannot change controller transactions.
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function isAppTarget(target) {
  return target?.type === "page" && typeof target.url === "string" && /^app:\/\//iu.test(target.url);
}

function targetFromNotification(notification) {
  const info = notification?.params?.targetInfo;
  if (!isAppTarget(info)) return null;
  const targetId = info.targetId ?? info.id;
  return typeof targetId === "string" && targetId.length > 0 ? { ...info, targetId } : null;
}

function isAuxiliaryTarget(target) {
  return typeof target?.url === "string" && /(?:avatar|overlay|popover|tooltip)/iu.test(target.url);
}

function boundedStderr(stream) {
  let bytes = 0;
  const chunks = [];
  stream?.on?.("data", (chunk) => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const available = Math.max(0, MAX_STDERR_BYTES - bytes);
    if (available > 0) chunks.push(value.subarray(0, available));
    bytes += value.length;
  });
  return () => Object.freeze({
    text: Buffer.concat(chunks).toString("utf8"),
    bytes,
    truncated: bytes > MAX_STDERR_BYTES,
  });
}

async function pollTargets(peer, { requestTimeoutMs, targetDeadlineMs }) {
  const deadline = Date.now() + targetDeadlineMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await peer.request("Target.getTargets", {}, { timeoutMs: requestTimeoutMs });
      return selectCodexTargets(response?.targetInfos);
    } catch (error) {
      lastError = error;
      await delay(150);
    }
  }
  const error = new Error("No Codex app page target appeared before the startup deadline");
  if (lastError) error.cause = lastError;
  throw error;
}

async function evaluate(peer, sessionId, expression, timeoutMs) {
  const response = await peer.request("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, { sessionId, timeoutMs });
  const evaluated = readEvaluationValue(response);
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description
      ?? evaluated.exceptionDetails.text
      ?? "Codex renderer evaluation failed");
  }
  return evaluated.value;
}

async function attach(peer, target, requestTimeoutMs) {
  const response = await peer.request("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  }, { timeoutMs: requestTimeoutMs });
  if (typeof response?.sessionId !== "string" || response.sessionId.length === 0) {
    throw new Error(`Target ${target.targetId} did not return a sessionId`);
  }
  return response.sessionId;
}

export function desktopExecutableFromCandidate(candidate) {
  const helperPath = candidate?.path;
  if (typeof helperPath !== "string" || helperPath.length === 0) {
    throw new TypeError("a package helper candidate path is required");
  }
  const normalized = helperPath.replaceAll("/", "\\");
  if (!/\\WindowsApps\\OpenAI\.Codex_[^\\]+__[^\\]+\\app\\resources\\codex\.exe$/iu.test(normalized)) {
    throw new Error("the resolved helper is not inside an OpenAI.Codex Windows package");
  }
  return join(dirname(helperPath), "..", "ChatGPT.exe");
}

export async function validateDesktopExecutable(candidate, { inspect = stat } = {}) {
  if (typeof inspect !== "function") throw new TypeError("inspect must be a function");
  const executable = desktopExecutableFromCandidate(candidate);
  const info = await inspect(executable);
  if (!info?.isFile?.()) throw new Error("the OpenAI.Codex desktop executable is unavailable");
  return executable;
}

export function openCodexThread(threadId, {
  launch = spawn,
  windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR,
} = {}) {
  if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 512
    || /[\0-\x1f\x7f]/u.test(threadId)) {
    throw new TypeError("threadId must be a bounded nonempty string without control characters");
  }
  if (typeof windowsDirectory !== "string" || windowsDirectory.length === 0
    || windowsDirectory.includes("\0") || !isAbsolute(windowsDirectory)) {
    throw new TypeError("an absolute Windows directory is required to open a Codex task");
  }
  const url = `codex://threads/${encodeURIComponent(threadId)}`;
  const child = launch(join(windowsDirectory, "explorer.exe"), [url], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref?.();
      resolve(Object.freeze({ status: "opened", threadId, url }));
    });
  });
}

export async function startReadonlySidebarController({
  executable,
  lock,
  binding,
  sourceKinds,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  targetDeadlineMs = DEFAULT_TARGET_DEADLINE_MS,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  interactionIntervalMs = DEFAULT_INTERACTION_INTERVAL_MS,
  interactionRequestTimeoutMs = DEFAULT_INTERACTION_REQUEST_TIMEOUT_MS,
  laneOverridePath = null,
}, {
  spawnProcess = spawn,
  createPeer = (child) => new CdpPipePeer(child.stdio[4], child.stdio[3], {
    child,
    maxInboundFrameBytes: 8 * 1024 * 1024,
  }),
  discoverTargets = pollTargets,
  readCatalog = readDesktopThreadCatalog,
  buildSnapshot = buildBoundReadonlyBoardSnapshot,
  buildDocument = buildStaticEmbeddedBoardDocument,
  loadOverrides = loadLaneOverrides,
  persistOverrides = persistLaneOverrides,
  openThread = openCodexThread,
} = {}) {
  if (typeof executable !== "string" || executable.length === 0) throw new TypeError("executable is required");
  if (!lock?.candidate || !binding?.candidate) throw new TypeError("Phase 0 lock and package binding are required");
  validateThreadSourceFilter(sourceKinds);
  for (const [value, name] of [
    [requestTimeoutMs, "requestTimeoutMs"],
    [targetDeadlineMs, "targetDeadlineMs"],
    [refreshIntervalMs, "refreshIntervalMs"],
    [interactionIntervalMs, "interactionIntervalMs"],
    [interactionRequestTimeoutMs, "interactionRequestTimeoutMs"],
  ]) positiveInteger(value, name);
  if (laneOverridePath !== null
    && (typeof laneOverridePath !== "string" || laneOverridePath.length === 0 || laneOverridePath.includes("\0"))) {
    throw new TypeError("laneOverridePath must be null or a nonempty path");
  }

  const child = spawnProcess(executable, ["--remote-debugging-pipe"], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  const stderr = boundedStderr(child.stderr);
  const events = new EventEmitter();
  const sessions = new Map();
  const targetsById = new Map();
  const confirmedSnapshots = new Map();
  const mountedTargets = new Set();
  const pendingMounts = new Map();
  let refreshTimer = null;
  let interactionTimer = null;
  let refreshRunning = false;
  let interactionRunning = false;
  let latestDocument = null;
  let latestSnapshot = null;
  let latestCatalog = null;
  let laneOverrides = Object.freeze([]);
  let disposed = false;
  let transactionTail = Promise.resolve();

  const enqueueTransaction = (operation) => {
    const queued = transactionTail.then(operation, operation);
    transactionTail = queued.catch(() => {});
    return queued;
  };

  const done = new Promise((resolve) => {
    let childError = null;
    child.once("error", (error) => { childError = error; });
    child.once("close", (exitCode, signal) => {
      disposed = true;
      if (refreshTimer) clearInterval(refreshTimer);
      if (interactionTimer) clearInterval(interactionTimer);
      resolve(Object.freeze({ exitCode, signal, error: childError, stderr: stderr() }));
    });
  });

  let peer;
  const notification = (message) => {
    if (message.method === "Target.targetDestroyed") {
      const targetId = message.params?.targetId;
      const forgetTarget = () => {
        sessions.delete(targetId);
        targetsById.delete(targetId);
        confirmedSnapshots.delete(targetId);
        mountedTargets.delete(targetId);
      };
      pendingMounts.delete(targetId);
      forgetTarget();
      enqueueTransaction(forgetTarget).catch(() => {});
      return;
    }
    const target = targetFromNotification(message);
    if (!target || !latestDocument || disposed) return;
    mountTarget(target).catch((error) => emitSafely(events, "mountError", error));
  };

  const mountSession = async (sessionId, html, snapshot) => {
    const result = await evaluate(
      peer,
      sessionId,
      buildFrameExpression("mount", { html, snapshot, layout: "sidebar", timeoutMs: 5_000 }),
      requestTimeoutMs,
    );
    if (result?.status !== "loaded"
      || result.count !== 1
      || result.snapshotId !== snapshot.snapshotId
      || result.renderedTaskCount !== snapshot.summary.taskCount) {
      throw new Error("Codex sidebar frame did not acknowledge the expected snapshot exactly once");
    }
    return result;
  };

  const markTargetsStale = async (targetIds, {
    fallbackSnapshot = null,
    candidateSnapshot = null,
  } = {}) => {
    await Promise.allSettled([...targetIds].map(async (targetId) => {
      const sessionId = sessions.get(targetId);
      if (!sessionId) return;
      const confirmedSnapshot = confirmedSnapshots.get(targetId) ?? fallbackSnapshot;
      const snapshots = [];
      if (confirmedSnapshot) snapshots.push(confirmedSnapshot);
      if (candidateSnapshot
        && candidateSnapshot.snapshotId !== confirmedSnapshot?.snapshotId) {
        snapshots.push(candidateSnapshot);
      }
      for (const snapshot of snapshots) {
        try {
          await evaluate(
            peer,
            sessionId,
            buildFrameExpression("stale", { snapshot }),
            requestTimeoutMs,
          );
        } catch {
          // Stale marking is best effort and must not conceal the refresh outcome.
        }
      }
    }));
  };

  const mountTarget = async (target) => {
    targetsById.set(target.targetId, target);
    if (pendingMounts.has(target.targetId)) return pendingMounts.get(target.targetId);
    let operation;
    operation = enqueueTransaction(async () => {
      const existingSession = sessions.get(target.targetId);
      if (existingSession) {
        if (latestDocument && !mountedTargets.has(target.targetId)) {
          await mountSession(existingSession, latestDocument, latestSnapshot);
          mountedTargets.add(target.targetId);
          confirmedSnapshots.set(target.targetId, latestSnapshot);
        }
        return existingSession;
      }
      const sessionId = await attach(peer, target, requestTimeoutMs);
      if (latestDocument) {
        await mountSession(sessionId, latestDocument, latestSnapshot);
        mountedTargets.add(target.targetId);
        confirmedSnapshots.set(target.targetId, latestSnapshot);
      }
      sessions.set(target.targetId, sessionId);
      return sessionId;
    }).finally(() => {
      if (pendingMounts.get(target.targetId) === operation) {
        pendingMounts.delete(target.targetId);
      }
    });
    pendingMounts.set(target.targetId, operation);
    return operation;
  };

  const readCurrentCatalog = async () => {
    const failures = [];
    const targetIds = [...sessions.keys()].sort((left, right) => {
      const auxiliaryOrder = Number(isAuxiliaryTarget(targetsById.get(left)))
        - Number(isAuxiliaryTarget(targetsById.get(right)));
      return auxiliaryOrder || left.localeCompare(right, "en");
    });
    for (const targetId of targetIds) {
      const sessionId = sessions.get(targetId);
      try {
        return await readCatalog(peer, sessionId, sourceKinds, { requestTimeoutMs });
      } catch (error) {
        failures.push(error);
      }
    }
    throw new AggregateError(failures, "No authenticated Codex renderer could read the task catalog");
  };

  const createSnapshot = async ({ reuseCatalog = false } = {}) => {
    if (reuseCatalog && latestCatalog === null) {
      throw new Error("No confirmed task catalog is available for a local board move");
    }
    const catalog = reuseCatalog ? latestCatalog : await readCurrentCatalog();
    const snapshot = buildSnapshot({
      lock,
      binding,
      catalog,
      laneOverrides,
      generatedAt: new Date().toISOString(),
    });
    if (!reuseCatalog) latestCatalog = catalog;
    return snapshot;
  };

  const refresh = async ({ reuseCatalog = false, preferredTargetId = null } = {}) => {
    if (disposed || (!reuseCatalog && refreshRunning)) return null;
    if (!reuseCatalog) refreshRunning = true;
    try {
      if (reuseCatalog && latestCatalog === null) {
        throw new Error("No confirmed task catalog is available for a local board move");
      }
      let catalog;
      try {
        catalog = reuseCatalog ? latestCatalog : await readCurrentCatalog();
      } catch (error) {
        emitSafely(events, "refreshError", error);
        throw error;
      }
      return await enqueueTransaction(async () => {
        const lastGoodSnapshot = latestSnapshot;
        let candidateSnapshot = null;
        const failedTargets = [];
        try {
          candidateSnapshot = buildSnapshot({
            lock,
            binding,
            catalog,
            laneOverrides,
            generatedAt: new Date().toISOString(),
          });
          const candidateDocument = await buildDocument(candidateSnapshot);
          const updateId = randomUUID();
          const expression = buildFrameExpression("update", {
            snapshot: candidateSnapshot,
            updateId,
            ...(candidateDocument.includes('data-projectboard-static="true"')
              ? { html: candidateDocument }
              : {}),
            timeoutMs: 5_000,
          });
          const updates = [];
          const orderedSessions = [...sessions].sort(([left], [right]) => {
            if (left === preferredTargetId) return -1;
            if (right === preferredTargetId) return 1;
            return left.localeCompare(right, "en");
          });
          for (const [targetId, sessionId] of orderedSessions) {
            try {
              let result = await evaluate(peer, sessionId, expression, requestTimeoutMs);
              if (result?.status === "missing" && latestDocument && latestSnapshot) {
                mountedTargets.delete(targetId);
                await mountSession(sessionId, latestDocument, latestSnapshot);
                mountedTargets.add(targetId);
                confirmedSnapshots.set(targetId, latestSnapshot);
                result = await evaluate(peer, sessionId, expression, requestTimeoutMs);
              }
              if (result?.status !== "updated" || result.updated !== true) {
                throw new Error("sidebar update was not acknowledged");
              }
              confirmedSnapshots.set(targetId, candidateSnapshot);
              updates.push(targetId);
            } catch (error) {
              failedTargets.push(targetId);
              emitSafely(events, "mountError", error);
            }
          }
          if (updates.length === 0) {
            throw new Error("No Codex renderer acknowledged the board snapshot");
          }
          latestSnapshot = candidateSnapshot;
          latestDocument = candidateDocument;
          latestCatalog = catalog;
          if (failedTargets.length > 0) {
            await markTargetsStale(failedTargets, {
              fallbackSnapshot: lastGoodSnapshot,
              candidateSnapshot,
            });
          }
          emitSafely(events, "refreshed", Object.freeze({
            snapshot: candidateSnapshot,
            targetIds: Object.freeze(updates),
          }));
          return candidateSnapshot;
        } catch (error) {
          const staleTargets = failedTargets.length > 0
            ? failedTargets
            : [...sessions.keys()];
          await markTargetsStale(staleTargets, {
            fallbackSnapshot: lastGoodSnapshot,
            candidateSnapshot,
          });
          emitSafely(events, "refreshError", error);
          throw error;
        }
      });
    } finally {
      if (!reuseCatalog) refreshRunning = false;
    }
  };

  const takePendingMove = async () => enqueueTransaction(async () => {
    if (laneOverridePath === null || !latestSnapshot) return null;
    const lanes = latestSnapshot.aggregate?.lanes;
    if (!Array.isArray(lanes)) return null;
    const locatedTasks = lanes.flatMap((lane) => Array.isArray(lane?.tasks)
      ? lane.tasks.map((task) => ({ task, laneId: lane.id }))
      : []);
    const mounted = [...mountedTargets].filter((targetId) => sessions.has(targetId));
    const interactionTargets = [...mounted].sort((left, right) => {
      const auxiliaryOrder = Number(isAuxiliaryTarget(targetsById.get(left)))
        - Number(isAuxiliaryTarget(targetsById.get(right)));
      return auxiliaryOrder || left.localeCompare(right, "en");
    });
    const interaction = await new Promise((resolve) => {
      if (interactionTargets.length === 0) {
        resolve(null);
        return;
      }
      let remaining = interactionTargets.length;
      let settled = false;
      for (const targetId of interactionTargets) {
        const sessionId = sessions.get(targetId);
        evaluate(
          peer,
          sessionId,
          buildFrameExpression("take-move", { snapshot: latestSnapshot }),
          interactionRequestTimeoutMs,
        ).then((result) => {
          if (!settled && (result?.status === "move" || result?.status === "open")) {
            settled = true;
            resolve({ targetId, result });
          }
        }, () => {
          // A hidden or suspended renderer cannot block a visible board.
        }).finally(() => {
          remaining -= 1;
          if (!settled && remaining === 0) resolve(null);
        });
      }
    });
    if (!interaction) return null;
    const { targetId, result } = interaction;
    const matches = locatedTasks.filter(({ task }) => task?.threadId === result.threadId);
    if (result.snapshotId !== latestSnapshot.snapshotId
      || matches.length !== 1
      || (result.status === "move" && !LOCAL_BOARD_LANES.includes(result.laneId))) {
      emitSafely(events, "moveError", new Error("Projectboard rejected an invalid local lane move"));
      return null;
    }
    if (result.status === "open") {
      try {
        await openThread(result.threadId);
      } catch (error) {
        if (error && typeof error === "object") error.projectboardAction = "open";
        throw error;
      }
      const opened = Object.freeze({ status: "opened", targetId, threadId: result.threadId });
      emitSafely(events, "threadOpened", opened);
      return opened;
    }
    const [{ laneId: currentLaneId }] = matches;
    if (currentLaneId === result.laneId) {
      return Object.freeze({ status: "unchanged", threadId: result.threadId, laneId: result.laneId });
    }
    const nextOverrides = upsertLaneOverride(laneOverrides, result);
    await persistOverrides(laneOverridePath, nextOverrides);
    laneOverrides = nextOverrides;
    const move = Object.freeze({
      status: "accepted",
      targetId,
      threadId: result.threadId,
      fromLaneId: currentLaneId,
      laneId: result.laneId,
    });
    emitSafely(events, "moveAccepted", move);
    return move;
  });

  const pollMoves = async () => {
    if (laneOverridePath === null || disposed || interactionRunning) return null;
    interactionRunning = true;
    try {
      const move = await takePendingMove();
      if (move?.status !== "accepted") return move;
      const snapshot = await refresh({ reuseCatalog: true, preferredTargetId: move.targetId });
      return Object.freeze({ ...move, snapshot });
    } catch (error) {
      emitSafely(events, error?.projectboardAction === "open" ? "openError" : "moveError", error);
      throw error;
    } finally {
      interactionRunning = false;
    }
  };

  try {
    peer = createPeer(child);
    peer.on?.("notification", notification);
    const version = await peer.request("Browser.getVersion", {}, { timeoutMs: requestTimeoutMs });
    if (typeof version?.product !== "string" || version.product.length === 0) {
      throw new Error("Browser.getVersion did not return a product string");
    }
    await peer.request("Target.setDiscoverTargets", { discover: true }, { timeoutMs: requestTimeoutMs });
    const targets = await discoverTargets(peer, { requestTimeoutMs, targetDeadlineMs });
    for (const target of targets) await mountTarget(target);
    if (laneOverridePath !== null) laneOverrides = await loadOverrides(laneOverridePath);
    latestSnapshot = await createSnapshot();
    latestDocument = await buildDocument(latestSnapshot);
    const mounts = await enqueueTransaction(async () => {
      const mounted = [];
      const failures = [];
      for (const [targetId, sessionId] of sessions) {
        try {
          await mountSession(sessionId, latestDocument, latestSnapshot);
          mountedTargets.add(targetId);
          confirmedSnapshots.set(targetId, latestSnapshot);
          mounted.push(targetId);
        } catch (error) {
          failures.push(error);
          sessions.delete(targetId);
          targetsById.delete(targetId);
          confirmedSnapshots.delete(targetId);
          mountedTargets.delete(targetId);
        }
      }
      if (mounted.length === 0) {
        throw failures[0] ?? new Error("No Codex app page target remained available for the sidebar");
      }
      return mounted;
    });
    let refreshDelayMs = refreshIntervalMs;
    const scheduleRefresh = (delayMs) => {
      refreshTimer = setTimeout(async () => {
        try {
          await refresh();
          refreshDelayMs = refreshIntervalMs;
        } catch {
          refreshDelayMs = Math.min(MAX_REFRESH_BACKOFF_MS, refreshDelayMs * 2);
        } finally {
          if (!disposed) scheduleRefresh(refreshDelayMs);
        }
      }, delayMs);
      refreshTimer.unref?.();
    };
    scheduleRefresh(refreshDelayMs);
    if (laneOverridePath !== null) {
      interactionTimer = setInterval(() => {
        pollMoves().catch(() => {});
      }, interactionIntervalMs);
      interactionTimer.unref?.();
    }
    const initialSnapshot = latestSnapshot;
    return Object.freeze({
      browserVersion: version.product,
      child,
      done,
      events,
      initialSnapshot,
      get currentSnapshot() { return latestSnapshot; },
      mountedTargetIds: Object.freeze(mounts),
      laneOverridePath,
      cdpMethods: Object.freeze(peer.outbound?.map(({ method }) => method) ?? []),
      refresh,
      pollMoves,
    });
  } catch (error) {
    disposed = true;
    if (refreshTimer) clearInterval(refreshTimer);
    if (interactionTimer) clearInterval(interactionTimer);
    peer?.off?.("notification", notification);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill?.("SIGTERM");
      } catch {
        // Preserve the startup failure; the child error/close listeners retain process evidence.
      }
    }
    error.stderr = stderr();
    throw error;
  }
}
