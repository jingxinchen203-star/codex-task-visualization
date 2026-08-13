import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBoundReadonlyBoardSnapshot,
  prepareReadonlyBoardSnapshot,
} from "../../src/phase-1/service.js";

const lock = Object.freeze({
  reportDirectory: "C:\\evidence\\run",
  phase0RunId: "run-1",
  standalonePhase1: "go-with-readonly-degradation",
  injectedPhase1: "no-go",
  accountType: "chatgpt",
  candidate: Object.freeze({
    version: "codex-cli test",
    executionDigest: "a".repeat(64),
  }),
  sourceKinds: Object.freeze(["vscode"]),
});

const candidate = Object.freeze({
  version: "codex-cli test",
  executionDigest: "a".repeat(64),
  launchRecipe: Object.freeze({ kind: "private-staged-snapshot" }),
});

const metadata = Object.freeze({
  id: "thread-1",
  name: "Readonly board",
  preview: "Readonly board",
  cwd: "C:\\Work",
  createdAt: 1,
  updatedAt: 2,
  status: Object.freeze({ type: "idle" }),
});

test("Phase 1 service binds the sealed identity before reading and projects one immutable snapshot", async () => {
  const calls = [];
  const snapshot = await prepareReadonlyBoardSnapshot({
    phase0Report: "C:\\evidence\\run",
    generatedAt: "2026-08-11T00:00:00.000Z",
  }, {
    loadLock: async (value) => { calls.push(["load", value]); return lock; },
    findLock: async () => { throw new Error("must not auto-discover when an explicit report is supplied"); },
    bindCandidate: async (value) => { calls.push(["bind", value]); return candidate; },
    readCatalog: async (value, sourceKinds) => {
      calls.push(["read", value, sourceKinds]);
      return {
        accountType: "chatgpt",
        requiresOpenaiAuth: true,
        activeThreads: [metadata],
        archivedThreads: [],
        outboundMethods: ["initialize", "initialized", "account/read", "thread/list", "thread/list"],
      };
    },
  });

  assert.deepEqual(calls, [
    ["load", "C:\\evidence\\run"],
    ["bind", lock],
    ["read", candidate, []],
  ]);
  assert.equal(snapshot.mode, "standalone-readonly");
  assert.equal(snapshot.summary.taskCount, 1);
  assert.equal(snapshot.source.phase0RunId, "run-1");
  assert.equal(snapshot.source.injectedPhase1, "no-go");
  assert.equal(snapshot.source.accountType, "chatgpt");
  assert.equal(Object.isFrozen(snapshot), true);
});

test("Phase 1 service discovers a lock only when no explicit report is supplied", async () => {
  let discoveredRoot = null;
  await prepareReadonlyBoardSnapshot({ phase0Root: "custom-artifacts" }, {
    loadLock: async () => { throw new Error("unexpected explicit load"); },
    findLock: async (root) => { discoveredRoot = root; return lock; },
    bindCandidate: async () => candidate,
    readCatalog: async () => ({
      accountType: "chatgpt",
      requiresOpenaiAuth: true,
      activeThreads: [],
      archivedThreads: [],
      outboundMethods: ["initialize", "initialized", "account/read", "thread/list", "thread/list"],
    }),
  });
  assert.equal(discoveredRoot, "custom-artifacts");
});

test("Phase 1 service refuses to present an account split as an empty board", async () => {
  await assert.rejects(
    prepareReadonlyBoardSnapshot({}, {
      findLock: async () => lock,
      bindCandidate: async () => candidate,
      readCatalog: async () => ({
        accountType: null,
        requiresOpenaiAuth: true,
        activeThreads: [],
        archivedThreads: [],
        outboundMethods: ["initialize", "initialized", "account/read", "thread/list", "thread/list"],
      }),
    }),
    (error) => error.code === "EACCOUNTIDENTITY" && /does not match/u.test(error.message),
  );
});

test("an authenticated desktop catalog is bound to the same Phase 0 identity model", () => {
  const snapshot = buildBoundReadonlyBoardSnapshot({
    lock,
    binding: {
      candidate,
      sourceKinds: lock.sourceKinds,
      continuity: "same-package-upgrade-readonly",
    },
    catalog: {
      accountType: "chatgpt",
      requiresOpenaiAuth: true,
      activeThreads: [metadata],
      archivedThreads: [],
      outboundMethods: ["account/read", "thread/list", "thread/list"],
    },
    generatedAt: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(snapshot.summary.taskCount, 1);
  assert.equal(snapshot.source.accountType, "chatgpt");
  assert.equal(snapshot.source.identityContinuity, "same-package-upgrade-readonly");
  assert.deepEqual(snapshot.source.outboundMethods, ["account/read", "thread/list", "thread/list"]);
});
