import { join } from "node:path";
import { buildReadonlyBoardSnapshot } from "./board-model.js";
import {
  findLatestPhase0IdentityLock,
  loadPhase0IdentityLock,
  resolveReadonlyPackageBinding,
} from "./identity-lock.js";
import { INTERACTIVE_THREAD_SOURCE_KINDS } from "./catalog-policy.js";
import { readReadonlyThreadCatalog } from "./read-catalog.js";

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function buildBoundReadonlyBoardSnapshot({ lock, binding, catalog, laneOverrides = [], generatedAt }) {
  if (!lock || typeof lock !== "object" || !lock.candidate) {
    throw new TypeError("Phase 0 identity lock is required");
  }
  const candidate = binding?.candidate ?? binding;
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("a resolved package candidate is required");
  }
  if (!catalog || typeof catalog !== "object") {
    throw new TypeError("a read-only thread catalog is required");
  }
  if (lock.accountType !== null && lock.accountType !== undefined && catalog.accountType !== lock.accountType) {
    throw codedError(
      "EACCOUNTIDENTITY",
      `Current package App Server account identity does not match Phase 0 (${catalog.accountType ?? "none"} != ${lock.accountType})`,
    );
  }
  return buildReadonlyBoardSnapshot({
    activeThreads: catalog.activeThreads,
    archivedThreads: catalog.archivedThreads,
    laneOverrides,
    generatedAt,
    identity: {
      phase0RunId: lock.phase0RunId,
      standalonePhase1: lock.standalonePhase1,
      candidateVersion: candidate.version,
      executionDigest: candidate.executionDigest,
      accountType: catalog.accountType,
      outboundMethods: catalog.outboundMethods,
      identityContinuity: binding?.continuity ?? "exact-phase0",
    },
  });
}

export async function prepareReadonlyBoardSnapshot({
  phase0Report = null,
  phase0Root = join("artifacts", "phase-0"),
  generatedAt = new Date().toISOString(),
} = {}, {
  loadLock = loadPhase0IdentityLock,
  findLock = findLatestPhase0IdentityLock,
  bindCandidate = resolveReadonlyPackageBinding,
  readCatalog = readReadonlyThreadCatalog,
} = {}) {
  if (phase0Report !== null && (typeof phase0Report !== "string" || phase0Report.length === 0)) {
    throw new TypeError("phase0Report must be null or a nonempty string");
  }
  if (typeof phase0Root !== "string" || phase0Root.length === 0) {
    throw new TypeError("phase0Root must be a nonempty string");
  }
  const lock = phase0Report === null
    ? await findLock(phase0Root)
    : await loadLock(phase0Report);
  const resolved = await bindCandidate(lock);
  const candidate = resolved?.candidate ?? resolved;
  const catalog = await readCatalog(candidate, INTERACTIVE_THREAD_SOURCE_KINDS);
  return buildBoundReadonlyBoardSnapshot({ lock, binding: resolved, catalog, generatedAt });
}
