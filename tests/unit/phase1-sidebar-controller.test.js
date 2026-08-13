import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import {
  desktopExecutableFromCandidate,
  openCodexThread,
  startReadonlySidebarController,
} from "../../src/phase-1/sidebar-controller.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdio = [null, null, child.stderr, {}, {}];
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return child;
}

function sidebarSnapshot(hex = "a", taskCount = 0) {
  return {
    snapshotId: hex.repeat(64),
    mode: "standalone-readonly",
    generatedAt: "2026-08-11T00:00:00.000Z",
    source: {},
    summary: { projectCount: taskCount === 0 ? 0 : 1, taskCount },
    aggregate: { id: "all-history", lanes: [] },
    projects: [],
  };
}

function staticSidebarDocument(snapshot) {
  return `<!doctype html><html data-projectboard-static="true"
    data-projectboard-mode="standalone-readonly"
    data-projectboard-snapshot-id="${snapshot.snapshotId}"
    data-projectboard-rendered-task-count="${snapshot.summary.taskCount}"><body></body></html>`;
}

test("desktop executable is derived only from the bound OpenAI.Codex package helper", () => {
  assert.equal(
    desktopExecutableFromCandidate({
      path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.803.10989.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe",
    }),
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.803.10989.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
  );
  assert.throws(() => desktopExecutableFromCandidate({ path: "C:\\tools\\codex.exe" }), /Windows package/u);
});

test("opening a validated task delegates one shell-free Codex protocol URL to Windows", async () => {
  const child = new EventEmitter();
  child.unref = () => { child.unrefCalled = true; };
  let launched;
  const opened = openCodexThread("thread/one", {
    windowsDirectory: "C:\\Windows",
    launch(executable, args, options) {
      launched = { executable, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });

  assert.deepEqual(await opened, {
    status: "opened",
    threadId: "thread/one",
    url: "codex://threads/thread%2Fone",
  });
  assert.deepEqual(launched, {
    executable: "C:\\Windows\\explorer.exe",
    args: ["codex://threads/thread%2Fone"],
    options: { shell: false, windowsHide: true, stdio: "ignore" },
  });
  assert.equal(child.unrefCalled, true);
  assert.throws(() => openCodexThread("bad\nthread", { windowsDirectory: "C:\\Windows" }), /threadId/u);
});

test("startup rejects a sidebar mount that has no renderer-ready receipt", async () => {
  const child = fakeChild();
  const peer = new EventEmitter();
  const interactionTimeouts = [];
  peer.request = async (method, params, meta) => {
    if (method === "Browser.getVersion") return { product: "Chrome/151" };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method === "Runtime.evaluate") {
      return { result: { value: { status: "loaded", count: 1 } } };
    }
    throw new Error(`unexpected method: ${method}`);
  };
  const snapshot = sidebarSnapshot("d", 1);

  await assert.rejects(
    startReadonlySidebarController({
      executable: "C:\\Package\\ChatGPT.exe",
      lock: { candidate: { path: "locked" } },
      binding: { candidate: { path: "current" } },
      sourceKinds: ["vscode"],
      refreshIntervalMs: 60_000,
    }, {
      spawnProcess: () => child,
      createPeer: () => peer,
      discoverTargets: async () => [{ targetId: "main", type: "page", url: "app://codex/" }],
      readCatalog: async () => ({ accountType: "chatgpt" }),
      buildSnapshot: () => snapshot,
      buildDocument: async () => "<!doctype html><title>Readonly board</title>",
    }),
    /did not acknowledge the expected snapshot/u,
  );
});

test("startup keeps an acknowledged primary renderer when a hidden auxiliary renderer rejects the mount", async () => {
  const child = fakeChild();
  const peer = new EventEmitter();
  const snapshot = sidebarSnapshot("e", 1);
  peer.request = async (method, params, meta = {}) => {
    if (method === "Browser.getVersion") return { product: "Chrome/151" };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method === "Runtime.evaluate") {
      if (meta.sessionId === "session-avatar-overlay") {
        return { result: { value: {
          status: "timeout",
          count: 1,
          error: "iframe renderer acknowledgement timed out",
        } } };
      }
      return { result: { value: {
        status: "loaded",
        count: 1,
        snapshotId: snapshot.snapshotId,
        renderedTaskCount: snapshot.summary.taskCount,
      } } };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  const controller = await startReadonlySidebarController({
    executable: "C:\\Package\\ChatGPT.exe",
    lock: { candidate: { path: "locked" } },
    binding: { candidate: { path: "current" } },
    sourceKinds: ["vscode"],
    refreshIntervalMs: 60_000,
  }, {
    spawnProcess: () => child,
    createPeer: () => peer,
    discoverTargets: async () => [
      { targetId: "main", type: "page", url: "app:///index.html" },
      { targetId: "avatar-overlay", type: "page", url: "app:///avatar-overlay" },
    ],
    readCatalog: async () => ({ accountType: "chatgpt" }),
    buildSnapshot: () => snapshot,
    buildDocument: async () => "<!doctype html><title>Readonly board</title>",
  });

  assert.deepEqual(controller.mountedTargetIds, ["main"]);
  child.emit("close", 0, null);
  await controller.done;
});

test("catalog reads prefer the primary renderer before a discovered auxiliary overlay", async () => {
  const child = fakeChild();
  const peer = new EventEmitter();
  const snapshot = sidebarSnapshot("f", 0);
  peer.request = async (method, params, meta = {}) => {
    if (method === "Browser.getVersion") return { product: "Chrome/151" };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method === "Runtime.evaluate") return { result: { value: {
      status: "loaded",
      count: 1,
      snapshotId: snapshot.snapshotId,
      renderedTaskCount: 0,
    } } };
    throw new Error(`unexpected method ${method} in ${meta.sessionId ?? "browser"}`);
  };
  const catalogSessions = [];
  const controller = await startReadonlySidebarController({
    executable: "C:\\Package\\ChatGPT.exe",
    lock: { candidate: { path: "locked" } },
    binding: { candidate: { path: "current" } },
    sourceKinds: ["vscode"],
    refreshIntervalMs: 60_000,
  }, {
    spawnProcess: () => child,
    createPeer: () => peer,
    discoverTargets: async () => [
      { targetId: "a-overlay", type: "page", url: "app:///avatar-overlay" },
      { targetId: "z-main", type: "page", url: "app:///index.html" },
    ],
    readCatalog: async (_peer, sessionId) => {
      catalogSessions.push(sessionId);
      return { accountType: "chatgpt" };
    },
    buildSnapshot: () => snapshot,
    buildDocument: async () => staticSidebarDocument(snapshot),
  });

  assert.deepEqual(catalogSessions, ["session-z-main"]);
  child.emit("close", 0, null);
  await controller.done;
});

test("sidebar controller launches a pipe-only desktop, reads through the authenticated bridge, and mounts once", async () => {
  const child = fakeChild();
  let spawnCall = null;
  const requests = [];
  const peer = new EventEmitter();
  peer.outbound = [];
  peer.request = async (method, params, meta) => {
    requests.push({ method, params, meta });
    peer.outbound.push({ method, params, ...meta });
    if (method === "Browser.getVersion") return { product: "Chrome/151" };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method === "Runtime.evaluate") {
      if (params.expression.includes("projectboard-phase1:update")) {
        return { result: { value: {
          status: "updated",
          updated: true,
          snapshotId: snapshot.snapshotId,
          renderedTaskCount: snapshot.summary.taskCount,
        } } };
      }
      assert.match(params.expression, /projectboard-phase0:mount/u);
      assert.match(params.expression, /projectboard-phase1-toggle/u);
      return { result: { value: {
        status: "loaded",
        count: 1,
        snapshotId: snapshot.snapshotId,
        renderedTaskCount: snapshot.summary.taskCount,
      } } };
    }
    throw new Error(`unexpected method: ${method}`);
  };
  const lock = {
    candidate: { path: "locked" },
    accountType: "chatgpt",
    phase0RunId: "phase0",
    standalonePhase1: "go-with-readonly-degradation",
  };
  const candidate = {
    path: "current",
    version: "codex-cli current",
    executionDigest: "a".repeat(64),
  };
  const snapshot = sidebarSnapshot("a", 0);
  const candidateSnapshot = sidebarSnapshot("b", 0);
  let snapshotBuilds = 0;
  const controller = await startReadonlySidebarController({
    executable: "C:\\Package\\ChatGPT.exe",
    lock,
    binding: { candidate, continuity: "same-package-upgrade-readonly" },
    sourceKinds: ["vscode"],
    refreshIntervalMs: 60_000,
  }, {
    spawnProcess(executable, args, options) {
      spawnCall = { executable, args, options };
      return child;
    },
    createPeer: () => peer,
    discoverTargets: async () => [{ targetId: "main", type: "page", url: "app://codex/" }],
    readCatalog: async (_peer, sessionId, sourceKinds) => {
      assert.equal(sessionId, "session-main");
      assert.deepEqual(sourceKinds, ["vscode"]);
      return {
        accountType: "chatgpt",
        requiresOpenaiAuth: true,
        activeThreads: [],
        archivedThreads: [],
        outboundMethods: ["account/read", "thread/list", "thread/list"],
      };
    },
    buildSnapshot: ({ catalog }) => {
      assert.equal(catalog.accountType, "chatgpt");
      return snapshotBuilds++ === 0 ? snapshot : candidateSnapshot;
    },
    buildDocument: async (value) => {
      return staticSidebarDocument(value);
    },
  });

  assert.deepEqual(spawnCall.args, ["--remote-debugging-pipe"]);
  assert.equal(spawnCall.args.some((arg) => /remote-debugging-port|user-data-dir/iu.test(arg)), false);
  assert.equal(spawnCall.options.shell, false);
  assert.deepEqual(controller.mountedTargetIds, ["main"]);
  assert.deepEqual(controller.initialSnapshot, snapshot);
  assert.deepEqual(controller.currentSnapshot, snapshot);
  assert.deepEqual(requests.map(({ method }) => method), [
    "Browser.getVersion",
    "Target.setDiscoverTargets",
    "Target.attachToTarget",
    "Runtime.evaluate",
  ]);
  assert.equal(requests.some(({ method }) => method === "Page.setBypassCSP"), false);

  const refreshed = await controller.refresh();
  assert.equal(refreshed, candidateSnapshot);
  assert.equal(requests.at(-1).method, "Runtime.evaluate");
  assert.match(requests.at(-1).params.expression, /projectboard-phase1:update/u);
  assert.ok(requests.at(-1).params.expression.includes(JSON.stringify(staticSidebarDocument(candidateSnapshot))));

  const requestCount = requests.length;
  const unchanged = await controller.refresh();
  assert.equal(unchanged, candidateSnapshot);
  assert.equal(requests.length, requestCount + 1, "refresh must still heal a missing renderer even when catalog identity is unchanged");

  child.emit("close", 0, null);
  const outcome = await controller.done;
  assert.equal(outcome.exitCode, 0);
});

test("refresh remounts a missing frame before applying the current snapshot", async () => {
  const child = fakeChild();
  const peer = new EventEmitter();
  peer.outbound = [];
  const evaluations = [];
  let updateCalls = 0;
  peer.request = async (method, params, meta = {}) => {
    peer.outbound.push({ method, params, ...meta });
    if (method === "Browser.getVersion") return { product: "Chrome/151" };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method === "Runtime.evaluate") {
      const action = params.expression.includes("projectboard-phase1:update") ? "update" : "mount";
      evaluations.push({ action, sessionId: meta.sessionId });
      if (action === "mount") return { result: { value: {
        status: "loaded",
        count: 1,
        snapshotId: snapshot.snapshotId,
        renderedTaskCount: snapshot.summary.taskCount,
      } } };
      updateCalls += 1;
      if (updateCalls === 1) return { result: { value: { status: "missing", updated: false } } };
      return { result: { value: {
        status: "updated",
        updated: true,
        snapshotId: snapshot.snapshotId,
        renderedTaskCount: snapshot.summary.taskCount,
      } } };
    }
    throw new Error(`unexpected method: ${method}`);
  };
  const snapshot = sidebarSnapshot("b", 2);
  const controller = await startReadonlySidebarController({
    executable: "C:\\Package\\ChatGPT.exe",
    lock: { candidate: { path: "locked" } },
    binding: { candidate: { path: "current" } },
    sourceKinds: ["vscode"],
    refreshIntervalMs: 60_000,
  }, {
    spawnProcess: () => child,
    createPeer: () => peer,
    discoverTargets: async () => [{ targetId: "main", type: "page", url: "app://codex/" }],
    readCatalog: async () => ({ accountType: "chatgpt" }),
    buildSnapshot: () => snapshot,
    buildDocument: async () => "<!doctype html><title>Readonly board</title>",
  });

  evaluations.length = 0;
  await controller.refresh();
  assert.deepEqual(evaluations, [
    { action: "update", sessionId: "session-main" },
    { action: "mount", sessionId: "session-main" },
    { action: "update", sessionId: "session-main" },
  ]);

  child.emit("close", 0, null);
  await controller.done;
});

test("a failed notification mount is not retained and repeated target notifications reuse one healthy session", async () => {
  const child = fakeChild();
  const peer = new EventEmitter();
  peer.outbound = [];
  const updateSessions = [];
  let auxMountAttempts = 0;
  let resolveAuxMounted;
  const auxMounted = new Promise((resolve) => { resolveAuxMounted = resolve; });
  peer.request = async (method, params, meta = {}) => {
    peer.outbound.push({ method, params, ...meta });
    if (method === "Browser.getVersion") return { product: "Chrome/151" };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method === "Runtime.evaluate") {
      if (params.expression.includes("projectboard-phase1:update")) {
        updateSessions.push(meta.sessionId);
        return { result: { value: {
          status: "updated",
          updated: true,
          snapshotId: snapshot.snapshotId,
          renderedTaskCount: snapshot.summary.taskCount,
        } } };
      }
      if (meta.sessionId === "session-aux") {
        auxMountAttempts += 1;
        if (auxMountAttempts === 1) throw new Error("late renderer was not ready");
        resolveAuxMounted();
      }
      return { result: { value: {
        status: "loaded",
        count: 1,
        snapshotId: snapshot.snapshotId,
        renderedTaskCount: snapshot.summary.taskCount,
      } } };
    }
    throw new Error(`unexpected method: ${method}`);
  };
  const snapshot = sidebarSnapshot("c", 2);
  const controller = await startReadonlySidebarController({
    executable: "C:\\Package\\ChatGPT.exe",
    lock: { candidate: { path: "locked" } },
    binding: { candidate: { path: "current" } },
    sourceKinds: ["vscode"],
    refreshIntervalMs: 60_000,
  }, {
    spawnProcess: () => child,
    createPeer: () => peer,
    discoverTargets: async () => [{ targetId: "main", type: "page", url: "app://codex/" }],
    readCatalog: async () => ({ accountType: "chatgpt" }),
    buildSnapshot: () => snapshot,
    buildDocument: async () => "<!doctype html><title>Readonly board</title>",
  });

  const firstFailure = once(controller.events, "mountError");
  peer.emit("notification", {
    method: "Target.targetCreated",
    params: { targetInfo: { targetId: "aux", type: "page", url: "app://codex/aux" } },
  });
  await firstFailure;

  updateSessions.length = 0;
  await controller.refresh();
  assert.deepEqual(updateSessions, ["session-main"], "a renderer that never mounted must not poison refresh");

  peer.emit("notification", {
    method: "Target.targetInfoChanged",
    params: { targetInfo: { targetId: "aux", type: "page", url: "app://codex/aux" } },
  });
  await auxMounted;
  peer.emit("notification", {
    method: "Target.targetInfoChanged",
    params: { targetInfo: { targetId: "aux", type: "page", url: "app://codex/aux" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const auxAttachments = peer.outbound.filter(({ method, params }) => method === "Target.attachToTarget" && params.targetId === "aux");
  assert.equal(auxAttachments.length, 2, "one failed attach may retry, but a mounted target must be reused");

  updateSessions.length = 0;
  await controller.refresh();
  assert.deepEqual(new Set(updateSessions), new Set(["session-main", "session-aux"]));

  child.emit("close", 0, null);
  await controller.done;
});

test("refresh promotes only an acknowledged snapshot, marks failures stale, and remounts the last good document", async () => {
  const child = fakeChild();
  const peer = new EventEmitter();
  peer.outbound = [];
  const initial = sidebarSnapshot("1", 1);
  const rejectedCandidate = sidebarSnapshot("2", 2);
  const acceptedCandidate = sidebarSnapshot("3", 3);
  const snapshots = [initial, rejectedCandidate, acceptedCandidate];
  let snapshotCall = 0;
  let updateCall = 0;
  let removeCalls = 0;
  const staleSnapshotIds = [];
  const mountedSnapshotIds = [];
  const snapshotIn = (expression) => snapshots.find(({ snapshotId }) => expression.includes(snapshotId));

  peer.request = async (method, params, meta = {}) => {
    peer.outbound.push({ method, params, ...meta });
    if (method === "Browser.getVersion") return { product: "Chrome/151" };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method !== "Runtime.evaluate") throw new Error(`unexpected method: ${method}`);
    if (params.expression.includes("projectboard-phase0:remove")) {
      removeCalls += 1;
      return { result: { value: { status: "removed", removed: 1 } } };
    }
    if (params.expression.includes("projectboard-phase1:stale")) {
      const stale = snapshotIn(params.expression);
      staleSnapshotIds.push(stale?.snapshotId);
      return { result: { value: { status: "stale", posted: true } } };
    }
    if (params.expression.includes("projectboard-phase1:update")) {
      updateCall += 1;
      const candidate = snapshotIn(params.expression);
      if (updateCall === 1) return { result: { value: { status: "timeout", updated: false } } };
      return { result: { value: {
        status: "updated",
        updated: true,
        snapshotId: candidate.snapshotId,
        renderedTaskCount: candidate.summary.taskCount,
      } } };
    }
    const mounted = snapshotIn(params.expression);
    mountedSnapshotIds.push(mounted?.snapshotId);
    return { result: { value: {
      status: "loaded",
      count: 1,
      snapshotId: mounted.snapshotId,
      renderedTaskCount: mounted.summary.taskCount,
    } } };
  };

  const controller = await startReadonlySidebarController({
    executable: "C:\\Package\\ChatGPT.exe",
    lock: { candidate: { path: "locked" } },
    binding: { candidate: { path: "current" } },
    sourceKinds: ["vscode"],
    refreshIntervalMs: 60_000,
  }, {
    spawnProcess: () => child,
    createPeer: () => peer,
    discoverTargets: async () => [{ targetId: "main", type: "page", url: "app://codex/" }],
    readCatalog: async () => ({ accountType: "chatgpt" }),
    buildSnapshot: () => snapshots[snapshotCall++],
    buildDocument: async (snapshot) => `<!doctype html><title>${snapshot.snapshotId}</title>`,
  });
  const refreshErrors = [];
  const refreshedEvents = [];
  controller.events.on("refreshError", (error) => refreshErrors.push(error));
  controller.events.on("refreshError", () => { throw new Error("host refreshError listener failed"); });
  controller.events.on("refreshed", (event) => refreshedEvents.push(event));
  controller.events.on("refreshed", () => { throw new Error("host refreshed listener failed"); });

  await assert.rejects(
    controller.refresh(),
    /No Codex renderer acknowledged the board snapshot/u,
  );
  assert.equal(controller.initialSnapshot.snapshotId, initial.snapshotId);
  assert.equal(controller.currentSnapshot.snapshotId, initial.snapshotId);
  assert.ok(staleSnapshotIds.includes(initial.snapshotId));
  assert.equal(removeCalls, 0, "a failed refresh must preserve the mounted last-good frame");
  assert.equal(refreshErrors.length, 1);
  assert.equal(refreshedEvents.length, 0);
  const staleCountAfterFailure = staleSnapshotIds.length;

  const refreshed = await controller.refresh();
  assert.equal(refreshed.snapshotId, acceptedCandidate.snapshotId);
  assert.equal(controller.currentSnapshot.snapshotId, acceptedCandidate.snapshotId);
  assert.equal(controller.initialSnapshot.snapshotId, initial.snapshotId, "the compatibility field must remain constant");
  assert.equal(refreshedEvents.length, 1);
  assert.equal(refreshedEvents[0].snapshot.snapshotId, acceptedCandidate.snapshotId);
  assert.equal(staleSnapshotIds.length, staleCountAfterFailure, "a host listener failure must not stale a promoted snapshot");

  peer.emit("notification", {
    method: "Target.targetCreated",
    params: { targetInfo: { targetId: "aux", type: "page", url: "app://codex/aux" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mountedSnapshotIds.at(-1), acceptedCandidate.snapshotId, "new renderers must mount the promoted snapshot");

  child.emit("close", 0, null);
  await controller.done;
});

test("a partial refresh stales each failed renderer at its own last confirmed identity", async () => {
  const child = fakeChild();
  const peer = new EventEmitter();
  peer.outbound = [];
  const initial = sidebarSnapshot("8", 1);
  const candidate = sidebarSnapshot("9", 2);
  const snapshots = [initial, candidate];
  let snapshotCall = 0;
  const stalePosts = [];
  let removeCalls = 0;

  peer.request = async (method, params, meta = {}) => {
    peer.outbound.push({ method, params, ...meta });
    if (method === "Browser.getVersion") return { product: "Chrome/151" };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method !== "Runtime.evaluate") throw new Error(`unexpected method: ${method}`);
    if (params.expression.includes("projectboard-phase0:remove")) {
      removeCalls += 1;
      return { result: { value: { status: "removed", removed: 1 } } };
    }
    if (params.expression.includes("projectboard-phase1:stale")) {
      const snapshot = snapshots.find(({ snapshotId }) => params.expression.includes(snapshotId));
      stalePosts.push({ sessionId: meta.sessionId, snapshotId: snapshot?.snapshotId });
      return { result: { value: { status: "stale", posted: true } } };
    }
    if (params.expression.includes("projectboard-phase1:update")) {
      if (meta.sessionId === "session-main") {
        return { result: { value: { status: "updated", updated: true } } };
      }
      return { result: { value: { status: "timeout", updated: false } } };
    }
    return { result: { value: {
      status: "loaded",
      count: 1,
      snapshotId: initial.snapshotId,
      renderedTaskCount: initial.summary.taskCount,
    } } };
  };

  const controller = await startReadonlySidebarController({
    executable: "C:\\Package\\ChatGPT.exe",
    lock: { candidate: { path: "locked" } },
    binding: { candidate: { path: "current" } },
    sourceKinds: ["vscode"],
    refreshIntervalMs: 60_000,
  }, {
    spawnProcess: () => child,
    createPeer: () => peer,
    discoverTargets: async () => [
      { targetId: "main", type: "page", url: "app://codex/" },
      { targetId: "aux", type: "page", url: "app://codex/aux" },
    ],
    readCatalog: async () => ({ accountType: "chatgpt" }),
    buildSnapshot: () => snapshots[snapshotCall++],
    buildDocument: async (snapshot) => `<!doctype html><title>${snapshot.snapshotId}</title>`,
  });

  const refreshed = await controller.refresh();
  assert.equal(refreshed.snapshotId, candidate.snapshotId);
  assert.ok(stalePosts.some(({ sessionId, snapshotId }) => (
    sessionId === "session-aux" && snapshotId === initial.snapshotId
  )), "the failed renderer must be marked stale using the snapshot it actually confirmed");
  assert.equal(controller.currentSnapshot?.snapshotId, candidate.snapshotId);
  assert.equal(stalePosts.some(({ sessionId }) => sessionId === "session-main"), false);
  assert.equal(removeCalls, 0);

  peer.emit("notification", { method: "Target.targetDestroyed", params: { targetId: "aux" } });
  child.emit("close", 0, null);
  await controller.done;
});

test("notification mounts and refreshes serialize so a late renderer cannot remain on the prior snapshot", async () => {
  const child = fakeChild();
  const peer = new EventEmitter();
  peer.outbound = [];
  const initial = sidebarSnapshot("a", 1);
  const candidate = sidebarSnapshot("b", 2);
  const snapshots = [initial, candidate];
  let snapshotCall = 0;
  let releaseAuxMount;
  let announceAuxMount;
  const auxMountStarted = new Promise((resolve) => { announceAuxMount = resolve; });
  const auxMountGate = new Promise((resolve) => { releaseAuxMount = resolve; });
  const updatedSessions = [];

  peer.request = async (method, params, meta = {}) => {
    peer.outbound.push({ method, params, ...meta });
    if (method === "Browser.getVersion") return { product: "Chrome/151" };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method !== "Runtime.evaluate") throw new Error(`unexpected method: ${method}`);
    if (params.expression.includes("projectboard-phase1:stale")) {
      return { result: { value: { status: "stale", posted: true } } };
    }
    if (params.expression.includes("projectboard-phase1:update")) {
      updatedSessions.push(meta.sessionId);
      return { result: { value: { status: "updated", updated: true } } };
    }
    const snapshot = snapshots.find(({ snapshotId }) => params.expression.includes(snapshotId));
    if (meta.sessionId === "session-aux" && snapshot.snapshotId === initial.snapshotId) {
      announceAuxMount();
      await auxMountGate;
    }
    return { result: { value: {
      status: "loaded",
      count: 1,
      snapshotId: snapshot.snapshotId,
      renderedTaskCount: snapshot.summary.taskCount,
    } } };
  };

  const controller = await startReadonlySidebarController({
    executable: "C:\\Package\\ChatGPT.exe",
    lock: { candidate: { path: "locked" } },
    binding: { candidate: { path: "current" } },
    sourceKinds: ["vscode"],
    refreshIntervalMs: 60_000,
  }, {
    spawnProcess: () => child,
    createPeer: () => peer,
    discoverTargets: async () => [{ targetId: "main", type: "page", url: "app://codex/" }],
    readCatalog: async () => ({ accountType: "chatgpt" }),
    buildSnapshot: () => snapshots[snapshotCall++],
    buildDocument: async (snapshot) => `<!doctype html><title>${snapshot.snapshotId}</title>`,
  });

  peer.emit("notification", {
    method: "Target.targetCreated",
    params: { targetInfo: { targetId: "aux", type: "page", url: "app://codex/aux" } },
  });
  await auxMountStarted;
  const refresh = controller.refresh();
  const ordering = await Promise.race([
    refresh.then(() => "refreshed"),
    new Promise((resolve) => setImmediate(() => resolve("waiting-for-mount"))),
  ]);
  releaseAuxMount();
  await refresh;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ordering, "waiting-for-mount", "refresh must queue behind the in-flight mount transaction");
  assert.ok(updatedSessions.includes("session-aux"), "the serialized refresh must advance the auxiliary renderer");
  assert.equal(controller.currentSnapshot.snapshotId, candidate.snapshotId);

  child.emit("close", 0, null);
  await controller.done;
});

test("a destroyed target cannot be restored by completion of an older in-flight mount", async () => {
  const child = fakeChild();
  const peer = new EventEmitter();
  const initial = sidebarSnapshot("c", 1);
  const candidate = sidebarSnapshot("d", 2);
  const snapshots = [initial, candidate];
  let snapshotCall = 0;
  let announceAuxMount;
  let releaseAuxMount;
  const auxMountStarted = new Promise((resolve) => { announceAuxMount = resolve; });
  const auxMountGate = new Promise((resolve) => { releaseAuxMount = resolve; });
  const updatedSessions = [];

  peer.request = async (method, params, meta = {}) => {
    if (method === "Browser.getVersion") return { product: "Chrome/151" };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method !== "Runtime.evaluate") throw new Error(`unexpected method: ${method}`);
    if (params.expression.includes("projectboard-phase1:update")) {
      updatedSessions.push(meta.sessionId);
      return { result: { value: { status: "updated", updated: true } } };
    }
    if (params.expression.includes("projectboard-phase1:stale")) {
      return { result: { value: { status: "stale", posted: true } } };
    }
    const snapshot = snapshots.find(({ snapshotId }) => params.expression.includes(snapshotId));
    if (meta.sessionId === "session-aux") {
      announceAuxMount();
      await auxMountGate;
    }
    return { result: { value: {
      status: "loaded",
      count: 1,
      snapshotId: snapshot.snapshotId,
      renderedTaskCount: snapshot.summary.taskCount,
    } } };
  };

  const controller = await startReadonlySidebarController({
    executable: "C:\\Package\\ChatGPT.exe",
    lock: { candidate: { path: "locked" } },
    binding: { candidate: { path: "current" } },
    sourceKinds: ["vscode"],
    refreshIntervalMs: 60_000,
  }, {
    spawnProcess: () => child,
    createPeer: () => peer,
    discoverTargets: async () => [{ targetId: "main", type: "page", url: "app://codex/" }],
    readCatalog: async () => ({ accountType: "chatgpt" }),
    buildSnapshot: () => snapshots[snapshotCall++],
    buildDocument: async (snapshot) => `<!doctype html><title>${snapshot.snapshotId}</title>`,
  });

  peer.emit("notification", {
    method: "Target.targetCreated",
    params: { targetInfo: { targetId: "aux", type: "page", url: "app://codex/aux" } },
  });
  await auxMountStarted;
  peer.emit("notification", { method: "Target.targetDestroyed", params: { targetId: "aux" } });
  releaseAuxMount();
  await new Promise((resolve) => setImmediate(resolve));
  await controller.refresh();

  assert.deepEqual(updatedSessions, ["session-main"], "destroy must win over an older mount completion");

  child.emit("close", 0, null);
  await controller.done;
});

test("a static move request falls through to the visible auxiliary board and republishes from the cached catalog", async () => {
  const child = fakeChild();
  const peer = new EventEmitter();
  peer.outbound = [];
  const task = {
    id: "thread-1",
    threadId: "thread-1",
    state: "inbox",
    sourceStatus: "idle",
  };
  const withLane = (snapshot, laneId) => ({
    ...snapshot,
    aggregate: {
      id: "all-history",
      lanes: ["inbox", "planned", "running", "review", "done"].map((id) => ({
        id,
        tasks: id === laneId ? [{ ...task, state: laneId }] : [],
      })),
    },
  });
  const initial = withLane(sidebarSnapshot("4", 1), "inbox");
  const moved = withLane(sidebarSnapshot("5", 1), "planned");
  let pendingInteraction = "move";
  let releaseSlowMainInteraction;
  const slowMainInteraction = new Promise((resolve) => { releaseSlowMainInteraction = resolve; });
  let announceRefreshRead;
  const refreshReadStarted = new Promise((resolve) => { announceRefreshRead = resolve; });
  let releaseRefreshRead;
  const blockedRefreshRead = new Promise((resolve) => { releaseRefreshRead = resolve; });
  let catalogReads = 0;
  const methods = [];
  const interactionAttempts = [];
  peer.request = async (method, params, meta) => {
    methods.push(method);
    peer.outbound.push({ method, params });
    if (method === "Browser.getVersion") return { product: "Chrome/151" };
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
    if (method === "Runtime.evaluate") {
      if (params.expression.includes("projectboard-phase1:take-move")) {
        interactionAttempts.push({ sessionId: meta?.sessionId, timeoutMs: meta?.timeoutMs });
        if (meta?.sessionId === "session-main" && pendingInteraction === "move") {
          return slowMainInteraction;
        }
        if (meta?.sessionId === "session-main") {
          return { result: { value: { status: "idle" } } };
        }
        if (pendingInteraction === "open") {
          pendingInteraction = "idle";
          return { result: { value: {
            status: "open",
            snapshotId: moved.snapshotId,
            threadId: "thread-1",
          } } };
        }
        if (pendingInteraction !== "move") return { result: { value: { status: "idle" } } };
        pendingInteraction = "open";
        return { result: { value: {
          status: "move",
          snapshotId: initial.snapshotId,
          threadId: "thread-1",
          laneId: "planned",
          currentLaneId: "inbox",
        } } };
      }
      if (params.expression.includes("projectboard-phase1:update")) {
        return { result: { value: { status: "updated", updated: true } } };
      }
      return { result: { value: {
        status: "loaded",
        count: 1,
        snapshotId: initial.snapshotId,
        renderedTaskCount: 1,
      } } };
    }
    throw new Error(`unexpected method: ${method}`);
  };
  const persisted = [];
  const seenOverrides = [];
  const openedThreads = [];
  const controller = await startReadonlySidebarController({
    executable: "C:\\Package\\ChatGPT.exe",
    lock: { candidate: { path: "locked" } },
    binding: { candidate: { path: "current" } },
    sourceKinds: ["vscode"],
    refreshIntervalMs: 60_000,
    interactionIntervalMs: 60_000,
    laneOverridePath: "C:\\state\\lane-overrides.v1.json",
  }, {
    spawnProcess: () => child,
    createPeer: () => peer,
    discoverTargets: async () => [
      { targetId: "main", type: "page", url: "app://codex/" },
      { targetId: "avatar-overlay", type: "page", url: "app://codex/avatar-overlay" },
    ],
    readCatalog: async () => {
      catalogReads += 1;
      if (catalogReads === 1) return { accountType: "chatgpt" };
      announceRefreshRead();
      return blockedRefreshRead;
    },
    loadOverrides: async (path) => {
      assert.equal(path, "C:\\state\\lane-overrides.v1.json");
      return Object.freeze([]);
    },
    persistOverrides: async (path, overrides) => {
      persisted.push({ path, overrides });
      return overrides;
    },
    openThread: async (threadId) => openedThreads.push(threadId),
    buildSnapshot: ({ laneOverrides }) => {
      seenOverrides.push(laneOverrides);
      return laneOverrides.some(({ threadId, laneId }) => threadId === "thread-1" && laneId === "planned")
        ? moved
        : initial;
    },
    buildDocument: async (snapshot) => staticSidebarDocument(snapshot),
  });

  const backgroundRefresh = controller.refresh();
  await refreshReadStarted;
  const result = await controller.pollMoves();
  assert.equal(result.status, "accepted");
  assert.equal(result.snapshot, moved);
  assert.equal(controller.currentSnapshot, moved);
  assert.deepEqual(persisted, [{
    path: "C:\\state\\lane-overrides.v1.json",
    overrides: [{ threadId: "thread-1", laneId: "planned" }],
  }]);
  releaseSlowMainInteraction({ result: { value: { status: "idle" } } });
  releaseRefreshRead({ accountType: "chatgpt" });
  await backgroundRefresh;
  assert.deepEqual(seenOverrides, [
    [],
    [{ threadId: "thread-1", laneId: "planned" }],
    [{ threadId: "thread-1", laneId: "planned" }],
  ]);
  const opened = await controller.pollMoves();
  assert.deepEqual(opened, { status: "opened", targetId: "avatar-overlay", threadId: "thread-1" });
  assert.deepEqual(openedThreads, ["thread-1"]);
  assert.deepEqual(interactionAttempts, [
    { sessionId: "session-main", timeoutMs: 5_000 },
    { sessionId: "session-avatar-overlay", timeoutMs: 5_000 },
    { sessionId: "session-main", timeoutMs: 5_000 },
    { sessionId: "session-avatar-overlay", timeoutMs: 5_000 },
  ], "interaction polling must race every mounted board without waiting for a suspended renderer");
  assert.deepEqual(persisted, [{
    path: "C:\\state\\lane-overrides.v1.json",
    overrides: [{ threadId: "thread-1", laneId: "planned" }],
  }], "opening a task must not write local lane state again");
  assert.equal(methods.includes("Runtime.evaluate"), true);
  assert.equal(methods.some((method) => /turn|thread\/(?:start|archive|delete)/u.test(method)), false);

  child.emit("close", 0, null);
  await controller.done;
});
