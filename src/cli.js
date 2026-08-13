import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { discoverCandidates, fingerprintCandidates } from "./app-server/candidates.js";
import { probeAppServerIdentity } from "./app-server/probe-readonly.js";
import { readThreadSourceKinds } from "./app-server/schema-contract.js";
import { probeDispatchRecovery } from "./journal/dispatch-journal.js";
import { runLiveSuite } from "./live/live-probes.js";
import { runPhase0 } from "./orchestrator.js";
import {
  OperationGuard,
  classifyExecutionPath,
  createOwnedDirectory,
  ensureLocalDirectory,
  safeRemoveOwnedDirectory,
} from "./process/security-policy.js";
import { writeReport } from "./report/write-report.js";
import { collectWindowsInventory } from "./windows/inventory.js";
import { generateAppServerSchema } from "../scripts/generate-app-server-schema.mjs";

const BOOLEAN_FLAGS = new Map([
  ["--allow-codex-restart", "allowCodexRestart"],
  ["--probe-existing-instance", "probeExistingInstance"],
  ["--allow-persistent-thread", "allowPersistentThread"],
  ["--allow-model-turns", "allowModelTurns"],
]);
const VALUE_FLAGS = new Map([["--fixture-cwd", "fixtureCwd"]]);

export function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) {
    throw new TypeError("arguments must be strings");
  }
  const mode = argv[0] ?? "readonly";
  if (mode !== "readonly" && mode !== "live") throw new Error("mode must be readonly or live");
  const result = {
    mode,
    allowCodexRestart: false,
    probeExistingInstance: false,
    allowPersistentThread: false,
    allowModelTurns: false,
    fixtureCwd: null,
  };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) throw new Error(`duplicate argument: ${argument}`);
    if (BOOLEAN_FLAGS.has(argument)) {
      seen.add(argument);
      result[BOOLEAN_FLAGS.get(argument)] = true;
      continue;
    }
    if (VALUE_FLAGS.has(argument)) {
      seen.add(argument);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (value.includes("\0")) throw new Error(`${argument} contains NUL`);
      result[VALUE_FLAGS.get(argument)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (result.fixtureCwd !== null && !path.isAbsolute(result.fixtureCwd)) {
    throw new Error("--fixture-cwd must be absolute");
  }
  if (result.fixtureCwd !== null) classifyExecutionPath(result.fixtureCwd);
  if (result.allowCodexRestart && result.probeExistingInstance) {
    throw new Error("restart and existing-instance probes are mutually exclusive");
  }
  if (result.allowModelTurns && !result.allowPersistentThread) {
    throw new Error("model turns require persistent thread consent");
  }
  if (result.allowPersistentThread && !result.allowModelTurns) {
    throw new Error("persistent thread probe requires model turns consent");
  }
  if (result.allowModelTurns && !result.fixtureCwd) throw new Error("model turns require --fixture-cwd");
  if (result.fixtureCwd && !result.allowModelTurns) throw new Error("--fixture-cwd is only valid with model turns");
  if (mode === "readonly" && (
    result.allowCodexRestart
    || result.probeExistingInstance
    || result.allowPersistentThread
    || result.allowModelTurns
    || result.fixtureCwd
  )) {
    throw new Error("readonly mode rejects mutation flags");
  }
  return result;
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function retainedOuterCleanup(deferred, message) {
  return Object.freeze({
    attempted: false,
    deferred,
    retained: true,
    ok: false,
    error: Object.freeze({ name: "Error", code: "ECHILDUNSETTLED", message }),
  });
}

export async function withOwnedSchemaDirectory(callback) {
  const guard = new OperationGuard({ timeoutMs: 180_000 });
  let owned = null;
  let primaryError = null;
  let result;
  try {
    const root = await ensureLocalDirectory(tmpdir(), guard);
    owned = await createOwnedDirectory(root.canonicalPath, "projectboard-phase0-schema-", guard);
    result = await callback(path.join(owned.canonicalPath, "schema"));
  } catch (error) {
    primaryError = error;
  }
  if (primaryError && owned && (primaryError.unsettled === true || primaryError.cleanup?.retained === true)) {
    const originalDeferred = primaryError.deferredCleanup;
    const hasDeferred = Boolean(originalDeferred?.then);
    primaryError.outerCleanup = retainedOuterCleanup(
      hasDeferred,
      hasDeferred
        ? "Outer schema workspace retained until generator settlement and cleanup complete"
        : "Outer schema workspace retained because generator settlement is unavailable",
    );
    if (hasDeferred) {
      primaryError.deferredCleanup = Promise.resolve(originalDeferred).then(async (generatorOutcome) => {
        if (generatorOutcome?.settlement?.unsettled !== false || generatorOutcome?.cleanup?.ok !== true) {
          return Object.freeze({
            generator: generatorOutcome,
            outerCleanup: retainedOuterCleanup(false, "Outer schema workspace retained because generator cleanup did not complete"),
          });
        }
        const outerCleanup = await safeRemoveOwnedDirectory(owned, { timeoutMs: 30_000 });
        return Object.freeze({ generator: generatorOutcome, outerCleanup: Object.freeze(outerCleanup) });
      }, (error) => Object.freeze({
        generator: Object.freeze({
          settlement: null,
          cleanup: null,
          error: Object.freeze({
            name: error?.name ?? "Error",
            code: error?.code ?? null,
            message: error?.message ?? String(error),
          }),
        }),
        outerCleanup: retainedOuterCleanup(false, "Outer schema workspace retained because deferred generator cleanup rejected"),
      }));
    }
    guard.dispose();
    throw primaryError;
  }
  const cleanup = owned ? await safeRemoveOwnedDirectory(owned, { timeoutMs: 30_000 }) : null;
  guard.dispose();
  if (cleanup && !cleanup.ok) {
    const cleanupError = codedError("ESCHEMACLEANUP", cleanup.error?.message ?? "schema workspace cleanup failed");
    cleanupError.cleanup = cleanup;
    if (primaryError) {
      primaryError.cleanupError = cleanupError;
      throw primaryError;
    }
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return result;
}

async function prepareLocalFixture(directory) {
  const guard = new OperationGuard({ timeoutMs: 30_000 });
  try {
    return (await ensureLocalDirectory(directory, guard)).canonicalPath;
  } finally {
    guard.dispose();
  }
}

async function confirmDesktopMarker(marker) {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(
      `Open Codex, find ${marker.marker}, then type its task ID (Enter means inconclusive): `,
    );
    return answer.trim() === marker.threadId;
  } finally {
    terminal.close();
  }
}

async function displayApprovalEvidence(evidence) {
  process.stderr.write(
    `\nApproval evidence (decision is fixed to decline):\n${JSON.stringify(evidence, null, 2)}\n`,
  );
}

function selectedCandidateEvidence(candidate) {
  const provenance = Array.isArray(candidate.provenance)
    ? candidate.provenance.map((entry) => Object.fromEntries(
      Object.entries(entry).filter(([, value]) => value !== undefined),
    ))
    : [];
  const versionOutcome = candidate.versionOutcome && typeof candidate.versionOutcome === "object"
    ? {
      ok: candidate.versionOutcome.ok === true,
      code: candidate.versionOutcome.code ?? null,
      signal: candidate.versionOutcome.signal ?? null,
      timedOut: candidate.versionOutcome.timedOut === true,
      aborted: candidate.versionOutcome.aborted === true,
      stdoutTruncated: candidate.versionOutcome.stdoutTruncated === true,
      stderrTruncated: candidate.versionOutcome.stderrTruncated === true,
      error: candidate.versionOutcome.error ?? null,
    }
    : null;
  const hashOutcome = candidate.hashOutcome && typeof candidate.hashOutcome === "object"
    ? {
      ok: candidate.hashOutcome.ok === true,
      value: candidate.hashOutcome.value ?? null,
      before: candidate.hashOutcome.before ?? null,
      after: candidate.hashOutcome.after ?? null,
      error: candidate.hashOutcome.error ?? null,
    }
    : null;
  return Object.freeze({
    origin: candidate.origin,
    originEvidence: candidate.originEvidence ?? null,
    path: candidate.path,
    canonicalPath: candidate.canonicalPath ?? null,
    accessible: candidate.accessible === true,
    exists: candidate.exists ?? null,
    viable: candidate.viable === true,
    channels: Object.freeze(Array.isArray(candidate.channels) ? [...candidate.channels] : []),
    provenance: Object.freeze(provenance.map(Object.freeze)),
    version: candidate.version,
    launcherSha256: candidate.launcherSha256,
    nativeSha256: candidate.nativeSha256,
    executionDigest: candidate.executionDigest,
    stagedExecutable: candidate.stagedExecutable === true,
    fingerprintError: candidate.fingerprintError ?? null,
    versionOutcome: versionOutcome ? Object.freeze(versionOutcome) : null,
    hashOutcome: hashOutcome ? Object.freeze(hashOutcome) : null,
  });
}

function schemaEvidence(manifest, sourceKinds) {
  return Object.freeze({
    version: manifest.version,
    executionDigest: manifest.executionDigest,
    launcherSha256: manifest.launcherSha256 ?? null,
    nativeSha256: manifest.nativeSha256 ?? null,
    schemaRawSha256: manifest.schemaSet?.rawSha256 ?? null,
    schemaSemanticSha256: manifest.schemaSet?.semanticSha256 ?? null,
    schemaFileCount: Array.isArray(manifest.schemaSet?.files) ? manifest.schemaSet.files.length : null,
    sourceKinds: Object.freeze([...sourceKinds]),
  });
}

function liveFailureEvidence(error) {
  return Object.freeze({
    name: typeof error?.name === "string" && error.name.length > 0 ? error.name : "Error",
    code: typeof error?.code === "string" || Number.isInteger(error?.code) ? error.code : null,
    message: typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : "Live suite failed without an error message",
  });
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  collectInventory: collectWindowsInventory,
  discover: discoverCandidates,
  fingerprint: fingerprintCandidates,
  withSchemaDirectory: withOwnedSchemaDirectory,
  generateSchema: generateAppServerSchema,
  readSourceKinds: readThreadSourceKinds,
  probeIdentity: probeAppServerIdentity,
  probeDispatch: probeDispatchRecovery,
  prepareFixture: prepareLocalFixture,
  runLive: runLiveSuite,
  confirmDesktop: confirmDesktopMarker,
  displayApproval: displayApprovalEvidence,
});

export function createDefaultProbes(options, overrides = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency !== "function") throw new TypeError(`${name} must be a function`);
  }
  const liveConsent = options.allowPersistentThread === true && options.allowModelTurns === true;
  let livePromise = null;
  const ensureLive = async (context) => {
    if (!liveConsent) return null;
    if (!context.selectedCandidate || !Array.isArray(context.sourceKinds)) {
      throw codedError("ELIVEPREREQUISITE", "live probe prerequisites were not established");
    }
    if (!livePromise) {
      livePromise = (async () => {
        const fixtureDirectory = await dependencies.prepareFixture(options.fixtureCwd);
        return dependencies.runLive(
          context.selectedCandidate,
          context.sourceKinds,
          fixtureDirectory,
          dependencies.confirmDesktop,
          {
            consent: {
              allowPersistentThread: options.allowPersistentThread,
              allowModelTurns: options.allowModelTurns,
            },
            displayApproval: dependencies.displayApproval,
          },
        );
      })();
    }
    return livePromise;
  };

  return {
    windows_inventory: async () => {
      const inventory = await dependencies.collectInventory();
      const hasIdentity = Boolean(inventory?.package)
        || inventory?.startApps?.length > 0
        || inventory?.commands?.some(({ source }) => typeof source === "string" && source.length > 0);
      return {
        ...inventory,
        status: hasIdentity ? "pass" : "inconclusive",
        notes: hasIdentity ? [] : ["Windows Codex identity evidence was not discovered"],
      };
    },
    secure_injection: async () => ({
      status: "skipped",
      notes: ["activation and network-security probing is intentionally deferred by the current operating contract"],
    }),
    app_server_identity: async (context) => {
      const discovered = await dependencies.discover(context.windows_inventory);
      const candidates = await dependencies.fingerprint(discovered);
      const selected = candidates.find(({ viable }) => viable === true);
      if (!selected) throw codedError("ENOAPPSERVER", "no viable App Server candidate was discovered");

      return dependencies.withSchemaDirectory(async (schemaDirectory) => {
        const manifest = await dependencies.generateSchema(selected.path, schemaDirectory);
        const sourceKinds = await dependencies.readSourceKinds(schemaDirectory);
        if (manifest.version !== selected.version
          || manifest.executionDigest !== selected.executionDigest
          || (selected.nativeSha256 && manifest.nativeSha256 !== selected.nativeSha256)
          || !sameStrings(manifest.sourceKinds, sourceKinds)) {
          throw codedError("EIDENTITYCHANGED", "candidate identity changed during schema generation");
        }
        const identity = await dependencies.probeIdentity(selected, sourceKinds);
        context.selectedCandidate = selected;
        context.sourceKinds = sourceKinds;
        let live = null;
        let liveFailure = null;
        if (liveConsent) {
          try {
            live = await ensureLive(context);
          } catch (error) {
            liveFailure = liveFailureEvidence(error);
          }
        }
        const packageIdentity = selected.origin === "package";
        const desktopIdentity = live?.appServerIdentity ?? null;
        const status = liveFailure
          ? "fail"
          : (liveConsent && packageIdentity && desktopIdentity?.status === "pass" ? "pass" : "inconclusive");
        const notes = [];
        if (!packageIdentity) notes.push("selected App Server candidate was not tied to the desktop package");
        if (liveFailure) notes.push(liveFailure.message);
        if (!liveConsent) {
          notes.push("desktop task visibility was not confirmed in readonly mode");
        } else if (desktopIdentity?.status !== "pass") {
          notes.push("desktop task visibility did not confirm the selected App Server identity");
        }
        return {
          status,
          notes,
          selected: selectedCandidateEvidence(selected),
          candidateVersionDrift: new Set(candidates.map(({ version }) => version).filter(Boolean)).size > 1,
          candidates: candidates.map(selectedCandidateEvidence),
          schema: schemaEvidence(manifest, sourceKinds),
          identity,
          ...(liveFailure ? { liveFailure } : {}),
          ...(live ? {
            liveIdentity: Object.freeze({
              quota: live.quota ?? null,
              marker: live.marker ?? null,
              appServerIdentity: desktopIdentity,
            }),
          } : {}),
        };
      });
    },
    approval_lifecycle: async (context) => {
      if (!liveConsent) return { status: "skipped", notes: ["live consent was not granted"] };
      const live = await ensureLive(context);
      return live?.approvalLifecycle;
    },
    double_write_control: async (context) => {
      if (!liveConsent) return { status: "skipped", notes: ["live consent was not granted"] };
      const live = await ensureLive(context);
      return live?.doubleWriteControl;
    },
    dispatch_recovery: async () => dependencies.probeDispatch(),
    local_api_security: async () => ({
      status: "skipped",
      notes: ["network-security probing is intentionally deferred by the current operating contract"],
    }),
  };
}

export async function main(argv, overrides = {}) {
  const parsed = parseArguments(argv);
  const makeRunId = overrides.randomUUID ?? randomUUID;
  const clock = overrides.now ?? (() => new Date());
  const reportRoot = path.resolve(overrides.reportRoot ?? path.join("artifacts", "phase-0"));
  if (typeof makeRunId !== "function" || typeof clock !== "function") {
    throw new TypeError("randomUUID and now overrides must be functions");
  }
  const runId = makeRunId();
  if (typeof runId !== "string" || runId.length === 0 || /[\\/\0]/u.test(runId)) {
    throw new TypeError("runId must be a filesystem-safe nonempty string");
  }
  const observedAt = clock();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) throw new TypeError("now must return a valid Date");
  const directoryName = `${observedAt.toISOString().replaceAll(":", "-")}-${runId}`;
  const reportDirectory = path.join(reportRoot, directoryName);
  const options = Object.freeze({ ...parsed, runId, observedAt: observedAt.toISOString() });
  const probes = overrides.probes ?? createDefaultProbes(options, overrides.dependencies);
  const orchestrate = overrides.runPhase0 ?? runPhase0;
  const writer = overrides.writeReport ?? writeReport;
  const report = await orchestrate(options, probes);
  const publication = await writer(reportDirectory, report);
  return Object.freeze({ ...report, reportDirectory: publication.directory });
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main(process.argv.slice(2)).then((report) => {
    process.stdout.write(`${JSON.stringify({
      reportDirectory: report.reportDirectory,
      phases: report.phases,
    }, null, 2)}\n`);
  }, (error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
