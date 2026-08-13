import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { discoverCandidates, fingerprintCandidates } from "../app-server/candidates.js";
import { readThreadSourceKinds } from "../app-server/schema-contract.js";
import { withOwnedSchemaDirectory } from "../cli.js";
import { collectWindowsInventory } from "../windows/inventory.js";
import { generateAppServerSchema } from "../../scripts/generate-app-server-schema.mjs";

const ALLOWED_STANDALONE_DECISIONS = new Set(["go", "go-with-readonly-degradation"]);

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function isHexDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value);
}

function samePath(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && left.replaceAll("/", "\\").toLowerCase() === right.replaceAll("/", "\\").toLowerCase();
}

function packageFamilyFromPath(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("/", "\\");
  const match = /\\WindowsApps\\(OpenAI\.Codex)_[^\\]+__([^\\]+)\\app\\resources\\codex\.exe$/iu.exec(normalized);
  return match ? `${match[1]}_${match[2]}`.toLowerCase() : null;
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validateRuntimeCandidate(candidate) {
  const valid = candidate
    && candidate.origin === "package"
    && candidate.viable === true
    && candidate.launchRecipe
    && typeof candidate.version === "string"
    && candidate.version.length > 0
    && isHexDigest(candidate.launcherSha256)
    && isHexDigest(candidate.nativeSha256)
    && isHexDigest(candidate.executionDigest);
  if (!valid) throw codedError("EBOUNDAPPNOTFOUND", "The selected package App Server is not viable");
}

function validateCandidate(selected, schema) {
  const valid = selected
    && typeof selected === "object"
    && selected.origin === "package"
    && selected.viable === true
    && typeof selected.path === "string"
    && selected.path.length > 0
    && typeof selected.version === "string"
    && selected.version.length > 0
    && isHexDigest(selected.launcherSha256)
    && isHexDigest(selected.nativeSha256)
    && isHexDigest(selected.executionDigest)
    && schema
    && typeof schema === "object"
    && schema.version === selected.version
    && schema.executionDigest === selected.executionDigest
    && schema.launcherSha256 === selected.launcherSha256
    && schema.nativeSha256 === selected.nativeSha256;
  if (!valid) throw codedError("EPHASE0IDENTITY", "Phase 0 report does not contain one coherent package App Server identity");
  if (!Array.isArray(schema.sourceKinds)
    || schema.sourceKinds.length === 0
    || schema.sourceKinds.some((value) => typeof value !== "string" || value.length === 0)
    || new Set(schema.sourceKinds).size !== schema.sourceKinds.length) {
    throw codedError("EPHASE0SCHEMA", "Phase 0 report does not contain valid generated thread source kinds");
  }
}

function identityEvidence(report) {
  const gate = Array.isArray(report?.gates)
    ? report.gates.find(({ id }) => id === "app_server_identity")
    : null;
  const evidence = Array.isArray(gate?.evidence)
    ? gate.evidence.find((entry) => entry?.selected?.origin === "package" && entry?.identity?.initialized === true)
    : null;
  if (!evidence) throw codedError("EPHASE0IDENTITY", "Phase 0 App Server identity evidence is missing");
  return evidence;
}

async function reportDirectoryFrom(path) {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (info.isDirectory()) return absolute;
  if (info.isFile() && absolute.toLowerCase().endsWith("report.json")) return dirname(absolute);
  throw codedError("EPHASE0REPORT", "Phase 0 report path must name a report directory or report.json");
}

export async function loadPhase0IdentityLock(path) {
  let directory;
  try {
    directory = await reportDirectoryFrom(path);
  } catch (error) {
    if (error?.code?.startsWith?.("EPHASE0")) throw error;
    throw codedError("EPHASE0REPORT", "Phase 0 report path is unavailable", error);
  }
  let report;
  let seal;
  try {
    [report, seal] = await Promise.all([
      readFile(join(directory, "report.json"), "utf8").then(JSON.parse),
      readFile(join(directory, ".report-sealed"), "utf8"),
    ]);
  } catch (error) {
    throw codedError("EPHASE0REPORT", "Phase 0 report or seal is unreadable", error);
  }
  if (typeof report?.runId !== "string" || report.runId.length === 0 || seal.trim() !== report.runId) {
    throw codedError("EPHASE0SEAL", "Phase 0 report seal does not match its run identity");
  }
  const standalonePhase1 = report?.phases?.standalonePhase1;
  if (!ALLOWED_STANDALONE_DECISIONS.has(standalonePhase1)) {
    throw codedError("EPHASE0NOGO", "Phase 0 did not authorize standalone read-only Phase 1");
  }
  const evidence = identityEvidence(report);
  validateCandidate(evidence.selected, evidence.schema);
  const selected = evidence.selected;
  return Object.freeze({
    reportDirectory: directory,
    phase0RunId: report.runId,
    standalonePhase1,
    injectedPhase1: report?.phases?.injectedPhase1 ?? "no-go",
    accountType: evidence.identity.accountType ?? null,
    candidate: Object.freeze({
      path: selected.path,
      canonicalPath: selected.canonicalPath ?? selected.path,
      version: selected.version,
      launcherSha256: selected.launcherSha256,
      nativeSha256: selected.nativeSha256,
      executionDigest: selected.executionDigest,
    }),
    sourceKinds: Object.freeze([...evidence.schema.sourceKinds]),
  });
}

export async function findLatestPhase0IdentityLock(root = join("artifacts", "phase-0")) {
  const absoluteRoot = resolve(root);
  let entries;
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch (error) {
    throw codedError("EPHASE0REPORT", "Phase 0 report root is unavailable", error);
  }
  const failures = [];
  for (const entry of entries.filter((value) => value.isDirectory()).sort((left, right) => right.name.localeCompare(left.name, "en"))) {
    try {
      return await loadPhase0IdentityLock(join(absoluteRoot, entry.name));
    } catch (error) {
      failures.push(error);
    }
  }
  throw codedError("EPHASE0REPORT", "No sealed Phase 0 report authorizes standalone read-only Phase 1", new AggregateError(failures));
}

export async function bindPhase0Candidate(lock, {
  collectInventory = collectWindowsInventory,
  discover = discoverCandidates,
  fingerprint = fingerprintCandidates,
} = {}) {
  if (!lock?.candidate) throw new TypeError("Phase 0 identity lock is required");
  const inventory = await collectInventory();
  const discovered = await discover(inventory);
  const matches = discovered.filter((candidate) => candidate.origin === "package"
    && (samePath(candidate.canonicalPath, lock.candidate.canonicalPath)
      || samePath(candidate.path, lock.candidate.path)));
  if (matches.length !== 1) {
    throw codedError("EBOUNDAPPNOTFOUND", "The package App Server recorded by Phase 0 is not uniquely discoverable");
  }
  const [candidate, ...extra] = await fingerprint(matches);
  if (extra.length > 0 || !candidate || candidate.origin !== "package" || candidate.viable !== true || !candidate.launchRecipe) {
    throw codedError("EBOUNDAPPNOTFOUND", "The Phase 0 package App Server is no longer viable");
  }
  const expected = lock.candidate;
  const stable = candidate.version === expected.version
    && candidate.launcherSha256 === expected.launcherSha256
    && candidate.nativeSha256 === expected.nativeSha256
    && candidate.executionDigest === expected.executionDigest;
  if (!stable) throw codedError("EIDENTITYDRIFT", "The package App Server identity changed after Phase 0");
  return candidate;
}

export async function resolveReadonlyPackageBinding(lock, {
  collectInventory = collectWindowsInventory,
  discover = discoverCandidates,
  fingerprint = fingerprintCandidates,
  withSchemaDirectory = withOwnedSchemaDirectory,
  generateSchema = generateAppServerSchema,
  readSourceKinds = readThreadSourceKinds,
} = {}) {
  if (!lock?.candidate || !Array.isArray(lock.sourceKinds)) {
    throw new TypeError("Phase 0 identity lock is required");
  }
  const inventory = await collectInventory();
  const discovered = await discover(inventory);
  const exact = discovered.filter((candidate) => candidate.origin === "package"
    && (samePath(candidate.canonicalPath, lock.candidate.canonicalPath)
      || samePath(candidate.path, lock.candidate.path)));
  let continuity = "exact-phase0";
  let selected;
  if (exact.length === 1) {
    [selected] = exact;
  } else if (exact.length > 1) {
    throw codedError("EBOUNDAPPNOTFOUND", "The package App Server recorded by Phase 0 is not uniquely discoverable");
  } else {
    const lockedFamily = packageFamilyFromPath(lock.candidate.canonicalPath ?? lock.candidate.path);
    if (!lockedFamily) throw codedError("EBOUNDAPPNOTFOUND", "The Phase 0 package family cannot be established");
    const sameFamily = discovered.filter((candidate) => candidate.origin === "package"
      && packageFamilyFromPath(candidate.canonicalPath ?? candidate.path) === lockedFamily);
    if (sameFamily.length !== 1) {
      throw codedError("EBOUNDAPPNOTFOUND", "A unique current helper from the Phase 0 package family was not found");
    }
    [selected] = sameFamily;
    continuity = "same-package-upgrade-readonly";
  }

  const [candidate, ...extra] = await fingerprint([selected]);
  if (extra.length > 0) throw codedError("EBOUNDAPPNOTFOUND", "Package fingerprinting returned ambiguous candidates");
  validateRuntimeCandidate(candidate);
  if (continuity === "exact-phase0") {
    const expected = lock.candidate;
    const stable = candidate.version === expected.version
      && candidate.launcherSha256 === expected.launcherSha256
      && candidate.nativeSha256 === expected.nativeSha256
      && candidate.executionDigest === expected.executionDigest;
    if (!stable) throw codedError("EIDENTITYDRIFT", "The package App Server identity changed at the Phase 0 path");
    return Object.freeze({
      candidate,
      sourceKinds: Object.freeze([...lock.sourceKinds]),
      continuity,
    });
  }

  return withSchemaDirectory(async (schemaDirectory) => {
    const manifest = await generateSchema(candidate.path, schemaDirectory);
    const sourceKinds = await readSourceKinds(schemaDirectory);
    const stable = manifest?.version === candidate.version
      && manifest?.launcherSha256 === candidate.launcherSha256
      && manifest?.nativeSha256 === candidate.nativeSha256
      && manifest?.executionDigest === candidate.executionDigest
      && sameStrings(manifest?.sourceKinds, sourceKinds);
    if (!stable) throw codedError("ESCHEMADRIFT", "The upgraded package schema does not match its execution identity");
    return Object.freeze({
      candidate,
      sourceKinds: Object.freeze([...sourceKinds]),
      continuity,
    });
  });
}
