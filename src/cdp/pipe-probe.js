import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { CdpPipePeer } from "./pipe-peer.js";
import { buildFrameExpression, readEvaluationValue, selectCodexTargets } from "./targets.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_ATTEMPTS = 10;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_POLL_DEADLINE_MS = 5_000;
const DEFAULT_STABLE_SNAPSHOTS = 2;
const DEFAULT_STDERR_BYTES = 64 * 1024;
const BLOB_FIXTURE_HTML = "<!doctype html><meta charset=utf-8><meta http-equiv=content-security-policy content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><title>Projectboard Phase 0</title><style>body{margin:0;background:#10131a;color:#f7f8fb;font:16px system-ui}main{padding:20px}</style><main>Projectboard secure pipe fixture</main>";
const EXPECTED_CLOSE_ERROR_CODES = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function boundedBytes(limit) {
  const chunks = [];
  let kept = 0;
  let total = 0;
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
    value() {
      return Object.freeze({
        text: Buffer.concat(chunks).toString("utf8"),
        bytes: total,
        truncated: total > kept,
      });
    },
  };
}

function waitForEvent(emitter, event, errorEvent = "error") {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      emitter.off(errorEvent, onError);
      resolve(args);
    };
    const onError = (error) => {
      emitter.off(event, onEvent);
      reject(error);
    };
    emitter.once(event, onEvent);
    emitter.once(errorEvent, onError);
  });
}

async function startIframeFixtureServer() {
  const host = "127.0.0.1";
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/projectboard.html") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end("<!doctype html><meta charset=utf-8><title>Projectboard Phase 0</title><main>Projectboard fixture</main>");
  });
  server.listen({ host, port: 0, exclusive: true });
  try {
    await waitForEvent(server, "listening");
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Iframe fixture server did not expose a TCP address");
  }
  const metadata = { host, port: address.port, url: `http://${host}:${address.port}/projectboard.html`, closed: false };
  let closePromise;
  return {
    metadata,
    source: Object.freeze({ url: metadata.url }),
    close() {
      closePromise ??= new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else {
            metadata.closed = true;
            resolve();
          }
        });
      });
      return closePromise;
    },
  };
}

function startBlobFixture() {
  const metadata = { kind: "blob", closed: false };
  return {
    metadata,
    source: Object.freeze({ html: BLOB_FIXTURE_HTML }),
    async close() { metadata.closed = true; },
  };
}

function observeChild(child) {
  const state = { closed: false, exitCode: null, signal: null, error: null };
  const settlement = new Promise((resolve) => {
    child.once("error", (error) => { state.error = error; });
    child.once("close", (exitCode, signal) => {
      state.closed = true;
      state.exitCode = exitCode;
      state.signal = signal;
      resolve({ ...state });
    });
  });
  return { state, settlement };
}

async function waitBounded(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function orderedAccumulatedTargets(accumulated) {
  return selectCodexTargets([...accumulated.values()]);
}

async function pollAppTargets(peer, { attempts, intervalMs, deadlineAt, requestTimeoutMs, stableSnapshots }) {
  let lastError = null;
  let previousFingerprint = null;
  let consecutiveSnapshots = 0;
  const accumulated = new Map();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) break;
    const response = await peer.request(
      "Target.getTargets",
      {},
      { timeoutMs: Math.max(1, Math.min(requestTimeoutMs, remaining)) },
    );
    let selected = [];
    try {
      selected = selectCodexTargets(response?.targetInfos);
    } catch (error) {
      lastError = error;
    }
    for (const target of selected) accumulated.set(target.targetId, target);
    const fingerprint = selected.map(({ targetId }) => targetId).join("\0");
    if (fingerprint === previousFingerprint) consecutiveSnapshots += 1;
    else {
      previousFingerprint = fingerprint;
      consecutiveSnapshots = 1;
    }
    if (accumulated.size > 0 && consecutiveSnapshots >= stableSnapshots) {
      return orderedAccumulatedTargets(accumulated);
    }
    if (attempt < attempts) {
      const waitMs = Math.min(intervalMs, Math.max(0, deadlineAt - Date.now()));
      if (waitMs > 0) await delay(waitMs);
    }
  }
  if (accumulated.size > 0) return orderedAccumulatedTargets(accumulated);
  const error = new Error("No Codex app page targets appeared before the polling bound");
  if (lastError) error.cause = lastError;
  throw error;
}

function isExpectedCloseTransportError(error) {
  if (!(error instanceof Error) || error.rpc || error.code === "ETIMEDOUT") return false;
  return EXPECTED_CLOSE_ERROR_CODES.has(error.code)
    || /^CDP (?:input|output|child) (?:is )?closed/iu.test(error.message);
}

function cleanChildOutcome(outcome) {
  return outcome?.closed === true && outcome.exitCode === 0 && outcome.signal === null && outcome.error === null;
}

function childOutcomeError(outcome) {
  if (!outcome) return null;
  if (outcome.error) return new Error(`Owned CDP child failed: ${outcome.error.message}`, { cause: outcome.error });
  if (outcome.signal) return new Error(`Owned CDP child exited on signal ${outcome.signal}`);
  if (outcome.exitCode !== 0) return new Error(`Owned CDP child exited with code ${String(outcome.exitCode)}`);
  return null;
}

function errorEvidence(error) {
  if (!error) return null;
  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
    code: error.code ?? null,
  };
}

function cleanupEvidence(forcedTermination, childOutcome, observed) {
  const settlement = childOutcome ?? observed?.state ?? null;
  return Object.freeze({
    forcedTermination: Object.freeze({
      ...forcedTermination,
      error: errorEvidence(forcedTermination.error),
    }),
    child: settlement ? Object.freeze({
      closed: settlement.closed,
      exitCode: settlement.exitCode,
      signal: settlement.signal,
      error: errorEvidence(settlement.error),
    }) : null,
  });
}

function attachCleanupEvidence(error, evidence) {
  if (error && !Object.hasOwn(error, "cleanup")) error.cleanup = evidence;
  return error;
}

function partialProbeEvidence(result) {
  if (!result) return null;
  return Object.freeze({
    browserVersion: result.browserVersion,
    mountResult: result.mountResult,
    rendererCount: result.renderers.length,
    renderers: Object.freeze(result.renderers.map((renderer) => Object.freeze({
      targetId: renderer.targetId,
      mounts: Object.freeze(renderer.mounts.map((mount) => Object.freeze({
        status: mount?.status ?? null,
        count: mount?.count ?? null,
      }))),
      count: renderer.count,
      removed: renderer.removed,
      exceptionCount: renderer.exceptionDetails.length,
    }))),
    fixture: Object.freeze({ ...result.fixture }),
    outboundMethods: Object.freeze(result.outbound.map(({ method }) => method)),
  });
}

async function evaluate(peer, sessionId, expression, timeoutMs) {
  const response = await peer.request(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    { sessionId, timeoutMs },
  );
  return readEvaluationValue(response);
}

async function mountRenderer(peer, target, fixtureSource, { requestTimeoutMs, frameLoadTimeoutMs }) {
  const attachment = await peer.request(
    "Target.attachToTarget",
    { targetId: target.targetId, flatten: true },
    { timeoutMs: requestTimeoutMs },
  );
  if (typeof attachment?.sessionId !== "string" || attachment.sessionId.length === 0) {
    throw new Error(`Target ${target.targetId} did not return a sessionId`);
  }
  const sessionId = attachment.sessionId;
  const exceptionDetails = [];
  const mounts = [];
  for (let run = 0; run < 2; run += 1) {
    const evaluated = await evaluate(
      peer,
      sessionId,
      buildFrameExpression("mount", { ...fixtureSource, timeoutMs: frameLoadTimeoutMs }),
      requestTimeoutMs,
    );
    mounts.push(evaluated.value);
    if (evaluated.exceptionDetails) exceptionDetails.push(evaluated.exceptionDetails);
  }
  const counted = await evaluate(peer, sessionId, buildFrameExpression("count"), requestTimeoutMs);
  if (counted.exceptionDetails) exceptionDetails.push(counted.exceptionDetails);
  const removed = await evaluate(peer, sessionId, buildFrameExpression("remove"), requestTimeoutMs);
  if (removed.exceptionDetails) exceptionDetails.push(removed.exceptionDetails);

  return {
    targetId: target.targetId,
    sessionId,
    mounts,
    count: counted.value?.count,
    removed: removed.value?.removed,
    exceptionDetails,
  };
}

export async function probeDirectPipe(executable, args = [], options = {}) {
  if (typeof executable !== "string" || executable.length === 0) throw new TypeError("executable must be a nonempty string");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new TypeError("args must be strings");
  const {
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    childCloseTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    targetPollAttempts = DEFAULT_POLL_ATTEMPTS,
    targetPollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    targetPollDeadlineMs = DEFAULT_POLL_DEADLINE_MS,
    targetStableSnapshots = DEFAULT_STABLE_SNAPSHOTS,
    frameLoadTimeoutMs = 2_000,
    maxStderrBytes = DEFAULT_STDERR_BYTES,
    fixtureMode = "http",
  } = options;
  for (const [value, name] of [
    [requestTimeoutMs, "requestTimeoutMs"],
    [childCloseTimeoutMs, "childCloseTimeoutMs"],
    [targetPollAttempts, "targetPollAttempts"],
    [targetPollIntervalMs, "targetPollIntervalMs"],
    [targetPollDeadlineMs, "targetPollDeadlineMs"],
    [targetStableSnapshots, "targetStableSnapshots"],
    [frameLoadTimeoutMs, "frameLoadTimeoutMs"],
  ]) positiveInteger(value, name);
  if (!Number.isInteger(maxStderrBytes) || maxStderrBytes < 0) {
    throw new TypeError("maxStderrBytes must be a nonnegative integer");
  }
  if (fixtureMode !== "http" && fixtureMode !== "blob") {
    throw new TypeError("fixtureMode must be http or blob");
  }

  const fixture = fixtureMode === "blob" ? startBlobFixture() : await startIframeFixtureServer();
  let child = null;
  let observed = null;
  let peer = null;
  const stderr = boundedBytes(maxStderrBytes);
  let stderrDone = Promise.resolve();
  let primaryError = null;
  let result = null;
  try {
    child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    });
    observed = observeChild(child);
    stderrDone = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (!child.stderr) return finish();
      child.stderr.on("data", (chunk) => stderr.add(chunk));
      child.stderr.once("error", finish);
      child.stderr.once("end", finish);
      child.stderr.once("close", finish);
      if (child.stderr.readableEnded || child.stderr.destroyed) finish();
    });
    const toChild = child.stdio[3];
    const fromChild = child.stdio[4];
    if (!toChild || !fromChild) throw new Error("Owned CDP child did not expose file descriptors 3 and 4");
    peer = new CdpPipePeer(fromChild, toChild, { child });

    const version = await peer.request("Browser.getVersion", {}, { timeoutMs: requestTimeoutMs });
    if (typeof version?.product !== "string" || version.product.length === 0) {
      throw new Error("Browser.getVersion did not return a product string");
    }
    const targets = await pollAppTargets(peer, {
      attempts: targetPollAttempts,
      intervalMs: targetPollIntervalMs,
      deadlineAt: Date.now() + targetPollDeadlineMs,
      requestTimeoutMs,
      stableSnapshots: targetStableSnapshots,
    });
    const renderers = [];
    for (const target of targets) {
      renderers.push(await mountRenderer(peer, target, fixture.source, { requestTimeoutMs, frameLoadTimeoutMs }));
    }
    const pass = renderers.length === targets.length && renderers.every(
      (renderer) => renderer.mounts.length === 2
        && renderer.mounts.every((mount) => mount?.status === "loaded" && mount.count === 1)
        && renderer.count === 1
        && renderer.removed === 1
        && renderer.exceptionDetails.length === 0,
    );
    result = {
      browserVersion: version.product,
      mountResult: pass ? "PASS" : "FAIL",
      renderers,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    let closeError = null;
    if (peer && observed && !observed.state.closed) {
      try {
        await peer.request("Browser.close", {}, { timeoutMs: childCloseTimeoutMs });
      } catch (error) {
        closeError = error;
      }
    }
    let childOutcome = observed ? await waitBounded(observed.settlement, childCloseTimeoutMs) : null;
    let forcedTermination = { requested: false, signal: null, accepted: false, error: null };
    if (child && observed && !childOutcome) {
      forcedTermination = { requested: true, signal: "SIGTERM", accepted: false, error: null };
      try {
        forcedTermination.accepted = child.kill("SIGTERM");
      } catch (error) {
        forcedTermination.error = error;
      }
      childOutcome = await waitBounded(observed.settlement, childCloseTimeoutMs);
    }
    const cleanup = cleanupEvidence(forcedTermination, childOutcome, observed);
    if (primaryError) {
      if (forcedTermination.requested) attachCleanupEvidence(primaryError, cleanup);
    } else if (closeError?.code === "ETIMEDOUT" && forcedTermination.requested) {
      primaryError = attachCleanupEvidence(closeError, cleanup);
    } else if (observed && !childOutcome) {
      primaryError = attachCleanupEvidence(new Error("Owned CDP child did not close within the bounded timeout"), cleanup);
    } else {
      primaryError = childOutcomeError(childOutcome);
      if (!primaryError && closeError && !(cleanChildOutcome(childOutcome) && isExpectedCloseTransportError(closeError))) {
        primaryError = closeError;
      }
    }
    try {
      await fixture.close();
    } catch (error) {
      if (!primaryError) primaryError = error;
    }
    await waitBounded(stderrDone, childCloseTimeoutMs);
    const stderrEvidence = stderr.value();
    if (primaryError && !Object.hasOwn(primaryError, "stderr")) primaryError.stderr = stderrEvidence;
    if (primaryError && result && !Object.hasOwn(primaryError, "probe")) {
      result.outbound = peer ? [...peer.outbound] : [];
      result.fixture = { ...fixture.metadata };
      primaryError.probe = partialProbeEvidence(result);
    }
    if (result) {
      result.outbound = peer ? [...peer.outbound] : [];
      result.fixture = { ...fixture.metadata };
      result.child = childOutcome ?? { ...observed?.state };
      result.stderr = stderrEvidence;
    }
  }
  if (primaryError) throw primaryError;
  return result;
}
