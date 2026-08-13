import { access as fsAccess, realpath as fsRealpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { classifyExecutionPath, hashFileStreaming, runCommand, serializeError } from "../process/run-command.js";
import { validateExecutionEvidence } from "../process/execution-evidence.js";
import { OperationGuard, validateLocalPath } from "../process/security-policy.js";
import { publicBinding, publicExecution } from "../process/execution-bundle.js";

function ordinalCompare(left, right) {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function rankClass(candidate) {
  if (candidate.viable === true) return 2;
  if (candidate.accessible) return 1;
  return 0;
}

export function rankCandidates(candidates) {
  return [...candidates].sort((left, right) => {
    const classDifference = rankClass(right) - rankClass(left);
    if (classDifference) return classDifference;
    if (left.viable === true && right.viable === true && left.origin !== right.origin) {
      if (left.origin === "package") return -1;
      if (right.origin === "package") return 1;
    }
    return ordinalCompare(left.canonicalPath ?? left.path, right.canonicalPath ?? right.path);
  });
}

export async function sha256File(filePath, options = {}) {
  return hashFileStreaming(filePath, options);
}

function codedOutcomeError(code, message) {
  return serializeError(Object.assign(new Error(message), { code }));
}

function baseProcessOutcome(result, error) {
  return {
    code: result?.code ?? null,
    signal: result?.signal ?? null,
    stdout: result?.stdout ?? "",
    stderr: result?.stderr ?? "",
    stdoutTruncated: result?.stdoutTruncated ?? false,
    stderrTruncated: result?.stderrTruncated ?? false,
    timedOut: result?.timedOut ?? false,
    aborted: result?.aborted ?? false,
    error,
  };
}

async function fingerprintCandidate(candidate, run, hash) {
  if (!candidate.accessible) {
    const error = codedOutcomeError("EINACCESSIBLE", "Candidate is inaccessible");
    return {
      ...candidate,
      exists: candidate.exists ?? null,
      directSpawnable: candidate.exists === false ? false : null,
      stagedExecutable: false,
      launchRecipe: null,
      viable: false,
      version: null,
      launcherSha256: null,
      nativeSha256: null,
      executionDigest: null,
      versionOutcome: { ok: false, value: null, ...baseProcessOutcome(null, error) },
      hashOutcome: { ok: false, value: null, before: null, after: null, error },
      execution: null,
      stagedBinding: null,
      fingerprintError: "inaccessible",
    };
  }

  let beforeHash = null;
  let afterHash = null;
  let hashError = null;
  try {
    beforeHash = await hash(candidate.path);
  } catch (error) {
    hashError = serializeError(error);
  }

  let result = null;
  let runError = null;
  try {
    result = await run(candidate.path, ["--version"]);
  } catch (error) {
    runError = serializeError(error);
  }

  if (!hashError) {
    try {
      afterHash = await hash(candidate.path);
      if (beforeHash !== afterHash) {
        hashError = codedOutcomeError("EIDENTITYCHANGED", "Candidate changed while fingerprinting");
      }
    } catch (error) {
      hashError = serializeError(error);
    }
  }

  const trimmedVersion = result?.stdout?.trim() ?? "";
  let versionError = runError ?? result?.error ?? null;
  let identityEvidence = null;
  if (!versionError) {
    try {
      identityEvidence = validateExecutionEvidence(result, "Version command");
    } catch (error) {
      versionError = serializeError(error);
    }
  }
  if (!versionError && (result?.stdoutTruncated || result?.stderrTruncated)) {
    versionError = codedOutcomeError("EOUTPUTTRUNCATED", "Version command output was truncated");
  }
  if (!versionError && result?.code !== 0) {
    versionError = codedOutcomeError("EVERSIONEXIT", result?.stderr?.trim() || "Version command failed");
  }
  if (!versionError && !trimmedVersion) {
    versionError = codedOutcomeError("EEMPTYVERSION", "Version command returned an empty version");
  }
  const versionOk = versionError === null;
  const hashOk = hashError === null && typeof beforeHash === "string" && beforeHash.length > 0;
  const stagedExecutable = result?.binding?.kind === "private-staged-snapshot" && result.binding.exact === true;
  const launchRecipe = identityEvidence ? Object.freeze({
    kind: "private-staged-snapshot",
    requestedPath: candidate.path,
    expectedExecutionDigest: identityEvidence.executionDigest,
    expectedNativeSha256: identityEvidence.nativeSha256,
    expectedContextDigest: identityEvidence.contextDigest,
  }) : null;
  const viable = versionOk && hashOk && launchRecipe !== null;
  const errors = [versionError, hashError].filter(Boolean).map(({ message }) => message);
  const nativeSha256 = result?.execution?.files?.find(({ role }) => role === "native")?.sha256 ?? null;

  return {
    ...candidate,
    exists: true,
    directSpawnable: null,
    stagedExecutable,
    launchRecipe,
    viable,
    version: versionOk ? trimmedVersion : null,
    launcherSha256: hashOk ? beforeHash : null,
    nativeSha256,
    executionDigest: result?.execution?.digest ?? null,
    versionOutcome: { ok: versionOk, value: versionOk ? trimmedVersion : null, ...baseProcessOutcome(result, versionError) },
    hashOutcome: { ok: hashOk, value: hashOk ? beforeHash : null, before: beforeHash, after: afterHash, error: hashError },
    execution: result?.execution ? publicExecution(result.execution) : null,
    stagedBinding: result?.binding ? publicBinding(result.binding) : null,
    fingerprintError: errors.length ? errors.join("; ") : null,
  };
}

export async function fingerprintCandidates(candidates, { run = runCommand, hash = sha256File } = {}) {
  const fingerprints = [];
  for (const candidate of candidates) fingerprints.push(await fingerprintCandidate(candidate, run, hash));
  return rankCandidates(fingerprints);
}

async function validateCandidateLocalPath(path) {
  const guard = new OperationGuard();
  try {
    return await validateLocalPath(path, { guard, kind: "file" });
  } finally {
    guard.dispose();
  }
}

async function discoveredCandidate(path, provenance, access, realpath, validate) {
  const unknownExistence = (error) => ({ state: "unknown", error: serializeError(error) });
  let locality;
  try {
    classifyExecutionPath(path);
    locality = await validate(path);
  } catch (error) {
    const missing = error.code === "ENOENT";
    return {
      path,
      canonicalPath: null,
      accessible: false,
      exists: missing ? false : null,
      existence: missing ? { state: "missing", error: serializeError(error) } : unknownExistence(error),
      accessOutcome: { ok: false, error: serializeError(error) },
      canonicalization: { ok: false, path: null, error: null, attempted: false },
      dedupeBasis: "lexical-case-folded",
      provenance,
      discoveryError: serializeError(error),
    };
  }
  if (locality) {
    return {
      path,
      canonicalPath: locality.canonicalPath,
      accessible: true,
      exists: true,
      existence: { state: "present", error: null },
      accessOutcome: { ok: true, error: null },
      canonicalization: { ok: true, path: locality.canonicalPath, error: null, attempted: true },
      dedupeBasis: "canonical-case-folded",
      provenance,
      discoveryError: null,
    };
  }
  try {
    await access(path);
  } catch (error) {
    const missing = error.code === "ENOENT";
    return {
      path,
      canonicalPath: null,
      accessible: false,
      exists: missing ? false : null,
      existence: missing ? { state: "missing", error: serializeError(error) } : unknownExistence(error),
      accessOutcome: { ok: false, error: serializeError(error) },
      canonicalization: { ok: false, path: null, error: null, attempted: false },
      dedupeBasis: "lexical-case-folded",
      provenance,
      discoveryError: serializeError(error),
    };
  }
  try {
    const canonicalPath = await realpath(path);
    classifyExecutionPath(canonicalPath);
    return {
      path,
      canonicalPath,
      accessible: true,
      exists: true,
      existence: { state: "present", error: null },
      accessOutcome: { ok: true, error: null },
      canonicalization: { ok: true, path: canonicalPath, error: null, attempted: true },
      dedupeBasis: "canonical-case-folded",
      provenance,
      discoveryError: null,
    };
  } catch (error) {
    const missing = error.code === "ENOENT";
    return {
      path,
      canonicalPath: null,
      accessible: !missing,
      exists: missing ? false : true,
      existence: missing ? { state: "missing", error: serializeError(error) } : { state: "present", error: null },
      accessOutcome: { ok: true, error: null },
      canonicalization: { ok: false, path: null, error: serializeError(error), attempted: true },
      dedupeBasis: "lexical-case-folded",
      provenance,
      discoveryError: serializeError(error),
    };
  }
}

function dedupeKey(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

function isWindowsAppPackagePath(path) {
  const normalized = path.replaceAll("/", "\\");
  return /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\resources\\codex\.exe$/iu.test(normalized);
}

export async function discoverCandidates(inventory, {
  access = fsAccess,
  realpath = fsRealpath,
  validate = validateCandidateLocalPath,
} = {}) {
  const evidence = (inventory.commands ?? [])
    .filter((command) => command.source)
    .map((command) => ({
      path: command.source,
      provenance: { ...command, channel: "command" },
    }));
  if (inventory.package?.installLocation) {
    const path = join(inventory.package.installLocation, "app", "resources", "codex.exe");
    evidence.push({
      path,
      provenance: {
        ...inventory.package,
        channel: "package",
        source: path,
      },
    });
  }

  const discovered = [];
  for (const item of evidence) discovered.push(await discoveredCandidate(item.path, item.provenance, access, realpath, validate));
  const deduplicated = new Map();
  for (const item of discovered) {
    const key = dedupeKey(item.canonicalPath ?? resolve(item.path));
    const existing = deduplicated.get(key);
    if (existing) {
      existing.provenance.push(item.provenance);
      existing.accessible ||= item.accessible;
      if (existing.exists !== true) existing.exists = item.exists;
      if (!existing.canonicalPath && item.canonicalPath) {
        existing.canonicalPath = item.canonicalPath;
        existing.canonicalization = item.canonicalization;
        existing.dedupeBasis = item.dedupeBasis;
      }
      if (item.discoveryError) existing.discoveryErrors.push(item.discoveryError);
      continue;
    }
    deduplicated.set(key, {
      path: item.path,
      canonicalPath: item.canonicalPath,
      accessible: item.accessible,
      exists: item.exists,
      existence: item.existence,
      accessOutcome: item.accessOutcome,
      canonicalization: item.canonicalization,
      dedupeBasis: item.dedupeBasis,
      provenance: [item.provenance],
      discoveryErrors: item.discoveryError ? [item.discoveryError] : [],
    });
  }
  for (const candidate of deduplicated.values()) {
    candidate.channels = [...new Set(candidate.provenance.map(({ channel }) => channel))];
    if (candidate.channels.includes("package")) {
      candidate.origin = "package";
      candidate.originEvidence = "package-inventory";
    } else if (isWindowsAppPackagePath(candidate.canonicalPath ?? candidate.path)) {
      candidate.origin = "package";
      candidate.originEvidence = "windows-app-package-path";
    } else {
      candidate.origin = "global";
      candidate.originEvidence = "command-discovery";
    }
  }
  return rankCandidates([...deduplicated.values()]);
}
