import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  assertRecipeMatches,
  cleanupStaged,
  hashFileStreaming,
  nativeSha256,
  publicBinding,
  publicExecution,
  resolveCommandGuarded,
  snapshotExecutionGuarded,
  stageExecution,
  validateRecipe,
  verifyBinding,
} from "./execution-bundle.js";
import {
  DEFAULT_TIMEOUT_MS,
  OperationGuard,
  classifyExecutionPath,
  codedError,
  createExecutionContext,
  publicExecutionContext,
  rejectUnknownOptions,
  serializeError,
  validateLocalPath,
} from "./security-policy.js";

export { classifyExecutionPath, hashFileStreaming, serializeError };

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 2_000;
const RUN_OPTION_KEYS = new Set(["timeoutMs", "deadlineAt", "maxOutputBytes", "signal", "cwd"]);
const PREPARE_OPTION_KEYS = new Set(["timeoutMs", "deadlineAt", "signal", "cwd"]);

function spawnFixed(executable, args, context, { pipeStdin = true, detached = process.platform !== "win32" } = {}) {
  return spawn(executable, args, {
    cwd: context.cwd,
    env: context.environment,
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: false,
    detached,
    stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
}

function boundedOutput(limit) {
  const chunks = [];
  let keptBytes = 0;
  let totalBytes = 0;
  return {
    add(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      const available = Math.max(0, limit - keptBytes);
      if (available > 0) {
        const kept = bytes.subarray(0, available);
        chunks.push(kept);
        keptBytes += kept.length;
      }
    },
    value() {
      return { text: Buffer.concat(chunks).toString("utf8"), bytes: totalBytes, truncated: totalBytes > keptBytes };
    },
  };
}

function trackedChild(child) {
  const state = { closed: false, code: null, signal: null, error: null };
  const promise = new Promise((resolveClose) => {
    child.once("error", (error) => { state.error = error; });
    child.once("close", (code, signal) => {
      state.closed = true;
      state.code = code;
      state.signal = signal;
      resolveClose({ code, signal, error: state.error });
    });
  });
  return { child, state, promise };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref?.();
  });
}

async function terminateProcessTree(tracked, context, reason) {
  if (tracked.state.closed) {
    return { requested: false, reason, scope: "process-tree", method: null, graceMs: 0, graceExpired: false, error: null };
  }
  const pid = tracked.child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return {
      requested: true, reason, scope: "process-tree", method: null, graceMs: TERMINATION_GRACE_MS,
      graceExpired: !tracked.state.closed, error: serializeError(codedError("EINVALIDPID", "Owned child has no valid PID")),
    };
  }

  let method;
  let terminationError = null;
  if (process.platform === "win32") {
    method = "taskkill-pid-tree";
    const terminationGuard = new OperationGuard({ timeoutMs: TERMINATION_GRACE_MS });
    try {
      const systemRoot = context.environment.SystemRoot ?? context.environment.WINDIR;
      if (!systemRoot) throw codedError("ECONTEXT", "Controlled environment has no Windows system root");
      const taskkill = (await validateLocalPath(join(systemRoot, "System32", "taskkill.exe"), { guard: terminationGuard, kind: "file" })).canonicalPath;
      const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
        cwd: context.cwd,
        env: context.environment,
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: false,
        stdio: ["ignore", "ignore", "ignore"],
      });
      const killerClose = new Promise((resolveClose) => {
        let error = null;
        killer.once("error", (value) => { error = value; });
        killer.once("close", (code, signal) => resolveClose({ code, signal, error }));
      });
      const outcome = await Promise.race([killerClose, delay(TERMINATION_GRACE_MS)]);
      if (!outcome) terminationError = codedError("ETERMINATIONGRACE", "Windows process-tree terminator did not settle within grace");
      else if (outcome.error) terminationError = outcome.error;
      else if (outcome.code !== 0 && !tracked.state.closed) terminationError = codedError("ETERMINATIONFAILED", `taskkill exited with code ${outcome.code}`);
    } catch (error) {
      terminationError = error;
    } finally {
      terminationGuard.dispose();
    }
  } else {
    method = "process-group-signal";
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") terminationError = error;
    }
  }

  const close = await Promise.race([tracked.promise.then(() => true), delay(TERMINATION_GRACE_MS).then(() => false)]);
  if (!close && process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") terminationError ??= error; }
  }
  const settledAfterForce = close || await Promise.race([tracked.promise.then(() => true), delay(250).then(() => false)]);
  return {
    requested: true,
    reason,
    scope: "process-tree",
    method,
    graceMs: TERMINATION_GRACE_MS,
    graceExpired: !settledAfterForce,
    error: serializeError(terminationError),
  };
}

async function postVerify(staged, resolved, initialExecution) {
  const guard = new OperationGuard({ timeoutMs: DEFAULT_TIMEOUT_MS });
  let binding = null;
  let executionAfter = null;
  try {
    binding = await verifyBinding(staged, guard);
    if (!binding.exact) throw codedError("EIDENTITYCHANGED", "Staged execution bytes changed while running");
    executionAfter = await snapshotExecutionGuarded(resolved, guard);
    const sourceStable = initialExecution.digest === executionAfter.digest;
    if (!sourceStable) {
      return {
        ok: false,
        error: serializeError(codedError("ESOURCECHANGED", "Execution source changed while command was running")),
        binding: publicBinding(binding),
        executionAfter: publicExecution(executionAfter),
        identityStable: true,
        sourceStable: false,
      };
    }
    return {
      ok: true, error: null, binding: publicBinding(binding), executionAfter: publicExecution(executionAfter),
      identityStable: true, sourceStable: true,
    };
  } catch (error) {
    return {
      ok: false,
      error: serializeError(error),
      binding: binding ? publicBinding(binding) : null,
      executionAfter: executionAfter ? publicExecution(executionAfter) : null,
      identityStable: binding?.exact ?? false,
      sourceStable: null,
    };
  } finally {
    guard.dispose();
  }
}

function operationState(guard) {
  return { timedOut: guard.kind === "timedOut", aborted: guard.kind === "aborted" };
}

function emptyResult(error, guard, execution = null, executionContext = null, cleanup = null) {
  return {
    code: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...operationState(guard),
    unsettled: false,
    termination: { requested: false, reason: null, scope: "process-tree", method: null, graceMs: 0, graceExpired: false, error: null },
    error: serializeError(error),
    execution: execution ? publicExecution(execution) : null,
    executionContext: executionContext ? publicExecutionContext(executionContext) : null,
    executionAfter: null,
    identityStable: false,
    sourceStable: null,
    binding: null,
    postVerification: { ok: false, error: serializeError(error), binding: null, executionAfter: null },
    cleanup: cleanup ?? { attempted: false, ok: true, error: null },
    settled: null,
  };
}

export async function runCommand(executable, args, options = {}) {
  rejectUnknownOptions(options, RUN_OPTION_KEYS);
  const { timeoutMs, deadlineAt, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, signal, cwd } = options;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new TypeError("args must be an array of strings");
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0) throw new TypeError("maxOutputBytes must be a nonnegative integer");
  const guard = new OperationGuard({ timeoutMs, deadlineAt, signal });
  let context = null;
  let resolved = null;
  let staged = null;
  let execution = null;

  try {
    guard.check();
    context = await createExecutionContext({ cwd, guard });
    resolved = await resolveCommandGuarded(executable, guard);
    staged = await stageExecution(resolved, guard);
    execution = staged.execution;
    const stdout = boundedOutput(maxOutputBytes);
    const stderr = boundedOutput(maxOutputBytes);
    const tracked = trackedChild(spawnFixed(staged.executablePath, [...staged.argvPrefix, ...args], context, { pipeStdin: false }));
    tracked.child.stdout?.on("data", (chunk) => stdout.add(chunk));
    tracked.child.stderr?.on("data", (chunk) => stderr.add(chunk));

    let close = null;
    let primaryError = null;
    let termination = { requested: false, reason: null, scope: "process-tree", method: null, graceMs: 0, graceExpired: false, error: null };
    try {
      close = await guard.race(tracked.promise);
      primaryError = close.error;
    } catch (error) {
      primaryError = guard.kind ? guard.error() : error;
      termination = await terminateProcessTree(tracked, context, guard.kind ?? "error");
      if (tracked.state.closed) close = { code: tracked.state.code, signal: tracked.state.signal, error: tracked.state.error };
    }

    const unsettled = !tracked.state.closed;
    const postVerification = unsettled
      ? { ok: false, error: serializeError(codedError("ECHILDUNSETTLED", "Owned child did not settle; post-verification skipped")), binding: null, executionAfter: null, identityStable: false, sourceStable: null }
      : await postVerify(staged, resolved, execution);
    let cleanup;
    let settled = null;
    if (unsettled) {
      const retainedStage = staged;
      settled = (async () => {
        const deferredClose = await tracked.promise;
        const deferredPostVerification = await postVerify(retainedStage, resolved, execution);
        const deferredCleanup = await cleanupStaged(retainedStage);
        const deferredStdout = stdout.value();
        const deferredStderr = stderr.value();
        return Object.freeze({
          code: deferredClose.code,
          signal: deferredClose.signal,
          error: serializeError(deferredClose.error),
          unsettled: false,
          termination,
          stdout: deferredStdout.text,
          stderr: deferredStderr.text,
          stdoutBytes: deferredStdout.bytes,
          stderrBytes: deferredStderr.bytes,
          stdoutTruncated: deferredStdout.truncated,
          stderrTruncated: deferredStderr.truncated,
          postVerification: deferredPostVerification,
          cleanup: deferredCleanup,
        });
      })();
      cleanup = {
        attempted: false,
        deferred: true,
        ok: false,
        error: serializeError(codedError("ECHILDUNSETTLED", "Staging retained until the owned child settles")),
      };
    } else {
      cleanup = await cleanupStaged(staged);
    }
    staged = null;
    const stdoutResult = stdout.value();
    const stderrResult = stderr.value();
    return {
      code: close?.code ?? null,
      signal: close?.signal ?? null,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      stdoutBytes: stdoutResult.bytes,
      stderrBytes: stderrResult.bytes,
      stdoutTruncated: stdoutResult.truncated,
      stderrTruncated: stderrResult.truncated,
      ...operationState(guard),
      unsettled,
      termination,
      error: serializeError(primaryError),
      execution: publicExecution(execution),
      executionContext: publicExecutionContext(context),
      executionAfter: postVerification.executionAfter,
      identityStable: postVerification.identityStable,
      sourceStable: postVerification.sourceStable,
      binding: postVerification.binding,
      postVerification,
      cleanup,
      settled,
    };
  } catch (error) {
    const cleanup = staged ? await cleanupStaged(staged) : error.cleanup ?? { attempted: false, ok: true, error: null };
    staged = null;
    if (guard.kind) return emptyResult(guard.error(), guard, execution, context, cleanup);
    if (execution) return emptyResult(error, guard, execution, context, cleanup);
    throw error;
  } finally {
    if (staged) await cleanupStaged(staged);
    guard.dispose();
  }
}

function publicRecipe(recipe) {
  return Object.freeze({
    kind: recipe.kind,
    requestedPath: recipe.requestedPath,
    expectedExecutionDigest: recipe.expectedExecutionDigest,
    expectedNativeSha256: recipe.expectedNativeSha256,
    expectedContextDigest: recipe.expectedContextDigest,
  });
}

export async function prepareStagedCommand(recipeInput, options = {}) {
  rejectUnknownOptions(options, PREPARE_OPTION_KEYS);
  const recipe = publicRecipe(validateRecipe(recipeInput));
  const { timeoutMs, deadlineAt, signal, cwd } = options;
  const guard = new OperationGuard({ timeoutMs, deadlineAt, signal });
  let staged = null;
  try {
    const context = await createExecutionContext({ cwd, guard });
    const resolved = await resolveCommandGuarded(recipe.requestedPath, guard);
    staged = await stageExecution(resolved, guard);
    assertRecipeMatches(recipe, staged.execution, context);
    let currentBinding = await verifyBinding(staged, guard);
    if (!currentBinding.exact) throw codedError("EIDENTITYCHANGED", "Prepared staged execution bytes changed before launch");
    guard.check();

    let spawnAttempted = false;
    let childSettled = false;
    let disposed = false;
    let settlementPromise = null;
    let disposePromise = null;
    const publicContext = publicExecutionContext(context);

    const resource = {
      kind: "private-staged-command",
      recipe,
      execution: publicExecution(staged.execution),
      executionContext: publicContext,
      get binding() { return publicBinding(currentBinding); },
      get settlement() { return settlementPromise; },
      get disposed() { return disposed; },
      async spawn(args) {
        if (disposed) throw codedError("EDISPOSED", "Staged command resource is disposed");
        if (spawnAttempted) throw codedError("EALREADYSPAWNED", "Staged command resource owns exactly one spawn attempt");
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new TypeError("args must be an array of strings");
        spawnAttempted = true;
        const preSpawnGuard = new OperationGuard({ timeoutMs: DEFAULT_TIMEOUT_MS, signal });
        try {
          const freshContext = await createExecutionContext({ cwd: context.cwd, guard: preSpawnGuard });
          const freshExecution = await snapshotExecutionGuarded(resolved, preSpawnGuard);
          assertRecipeMatches(recipe, freshExecution, freshContext);
          currentBinding = await verifyBinding(staged, preSpawnGuard);
          if (!currentBinding.exact) throw codedError("EIDENTITYCHANGED", "Staged execution bytes changed before spawn");
          preSpawnGuard.check();
        } catch (error) {
          childSettled = true;
          throw error;
        } finally {
          preSpawnGuard.dispose();
        }

        let tracked;
        try {
          tracked = trackedChild(spawnFixed(staged.executablePath, [...staged.argvPrefix, ...args], context, { pipeStdin: true }));
        } catch (error) {
          childSettled = true;
          throw error;
        }
        let terminationPromise = null;
        let aborted = false;
        const requestTermination = (reason) => {
          if (reason === "aborted") aborted = true;
          terminationPromise ??= terminateProcessTree(tracked, context, reason);
          return terminationPromise;
        };
        const onAbort = () => { void requestTermination("aborted"); };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });

        settlementPromise = (async () => {
          const close = await tracked.promise;
          const termination = terminationPromise ? await terminationPromise : {
            requested: false, reason: null, scope: "process-tree", method: null, graceMs: 0, graceExpired: false, error: null,
          };
          signal?.removeEventListener("abort", onAbort);
          childSettled = true;
          return Object.freeze({
            code: close.code,
            signal: close.signal,
            error: serializeError(close.error),
            aborted,
            unsettled: false,
            termination,
          });
        })();

        return Object.freeze({
          stdin: tracked.child.stdin,
          stdout: tracked.child.stdout,
          stderr: tracked.child.stderr,
          pid: tracked.child.pid,
          settlement: settlementPromise,
          terminate: () => requestTermination("requested"),
        });
      },
      dispose() {
        if (spawnAttempted && !childSettled) return Promise.reject(codedError("ECHILDACTIVE", "Cannot dispose an unsettled owned child"));
        if (disposePromise) return disposePromise;
        disposePromise = (async () => {
          const postVerification = await postVerify(staged, resolved, staged.execution);
          const cleanup = await cleanupStaged(staged);
          disposed = true;
          if (!cleanup.ok) {
            const error = codedError(cleanup.error.code ?? "ECLEANUP", cleanup.error.message);
            error.outcome = { postVerification, cleanup };
            throw error;
          }
          if (!postVerification.ok && postVerification.error?.code !== "ESOURCECHANGED") {
            const error = codedError(postVerification.error.code ?? "EPOSTVERIFY", postVerification.error.message);
            error.outcome = { postVerification, cleanup };
            throw error;
          }
          return Object.freeze({ postVerification, cleanup });
        })();
        return disposePromise;
      },
    };
    return Object.freeze(resource);
  } catch (error) {
    if (staged) {
      const cleanup = await cleanupStaged(staged);
      if (!cleanup.ok) error.cleanup = cleanup;
    }
    throw error;
  } finally {
    guard.dispose();
  }
}
