import test from "node:test";
import assert from "node:assert/strict";
import { BOARD_LANES, buildReadonlyBoardSnapshot } from "../../src/phase-1/board-model.js";

const identity = Object.freeze({
  phase0RunId: "phase-zero-run",
  standalonePhase1: "go-with-readonly-degradation",
  candidateVersion: "codex-cli test",
  executionDigest: "a".repeat(64),
  accountType: "chatgpt",
  outboundMethods: ["initialize", "initialized", "account/read", "thread/list", "thread/list"],
});

function thread(overrides = {}) {
  return {
    id: "thread-1",
    name: "Implement the board",
    preview: "A private preview that should not be copied when a name exists",
    cwd: "C:\\Work\\Project",
    createdAt: 100,
    updatedAt: 200,
    status: { type: "idle" },
    ...overrides,
  };
}

test("readonly projection creates five stable lanes without inventing planned or completed state", () => {
  const snapshot = buildReadonlyBoardSnapshot({
    activeThreads: [
      thread(),
      thread({
        id: "thread-2",
        name: null,
        preview: "Waiting for a decision\nwith a second line",
        cwd: "c:/work/project/",
        updatedAt: 300,
        status: { type: "active", activeFlags: ["waitingOnUserInput"] },
      }),
      thread({
        id: "thread-3",
        name: "Broken task",
        cwd: "C:\\Other",
        updatedAt: 250,
        status: { type: "systemError" },
      }),
    ],
    archivedThreads: [thread({ id: "thread-4", name: "Imported history", updatedAt: 50 })],
    identity,
    generatedAt: "2026-08-11T00:00:00.000Z",
  });

  assert.deepEqual(BOARD_LANES.map(({ id }) => id), ["inbox", "planned", "running", "review", "done"]);
  assert.equal(Object.isFrozen(BOARD_LANES), true);
  assert.equal(snapshot.mode, "standalone-readonly");
  assert.equal(snapshot.generatedAt, "2026-08-11T00:00:00.000Z");
  assert.deepEqual(snapshot.summary, {
    projectCount: 2,
    taskCount: 4,
    activeThreadCount: 3,
    archivedThreadCount: 1,
    attentionCount: 2,
  });
  assert.equal(snapshot.aggregate.id, "all-history");
  assert.equal(snapshot.aggregate.name, "全部历史");
  assert.equal(snapshot.aggregate.counts.total, 4);
  assert.deepEqual(snapshot.aggregate.lanes.map(({ id, tasks }) => [id, tasks.length]), [
    ["inbox", 3],
    ["planned", 0],
    ["running", 1],
    ["review", 0],
    ["done", 0],
  ]);
  assert.equal(new Set(snapshot.aggregate.lanes.flatMap(({ tasks }) => tasks.map(({ id }) => id))).size, 4);

  const project = snapshot.projects.find(({ workspace }) => workspace === "C:\\Work\\Project");
  assert.ok(project);
  assert.equal(project.status, "archived");
  assert.deepEqual(project.lanes.map(({ id, tasks }) => [id, tasks.length]), [
    ["inbox", 2],
    ["planned", 0],
    ["running", 1],
    ["review", 0],
    ["done", 0],
  ]);
  const running = project.lanes.find(({ id }) => id === "running").tasks[0];
  assert.equal(running.title, "Waiting for a decision");
  assert.equal(running.archived, false);
  assert.deepEqual(running.attention, { kind: "user-input", label: "等待你的输入" });
  assert.equal(running.nextAction, "回到原任务，补充 Codex 需要的信息");

  const archived = project.lanes.find(({ id }) => id === "inbox").tasks.find(({ id }) => id === "thread-4");
  assert.equal(archived.archived, true);
  assert.equal(archived.nextAction, "可以整理到更合适的任务栏");
  assert.equal(JSON.stringify(archived).includes("private preview"), false);

  const other = snapshot.projects.find(({ workspace }) => workspace === "C:\\Other");
  const broken = other.lanes.find(({ id }) => id === "inbox").tasks[0];
  assert.deepEqual(broken.attention, { kind: "system-error", label: "Codex 状态异常" });
  assert.equal(broken.sourceStatus, "systemError");
});

test("readonly projection is bounded and prefers active metadata across catalogs", () => {
  const longPreview = `  ${"x".repeat(400)}  `;
  const snapshot = buildReadonlyBoardSnapshot({
    activeThreads: [thread({ name: null, preview: longPreview })],
    archivedThreads: [],
    identity,
    generatedAt: "2026-08-11T00:00:00.000Z",
  });
  const task = snapshot.projects[0].lanes[0].tasks[0];
  assert.equal(task.title.length <= 120, true);
  assert.equal("preview" in task, false);
  assert.equal("turns" in task, false);

  const overlapSnapshot = buildReadonlyBoardSnapshot({
    activeThreads: [thread({ id: "shared", updatedAt: 300 })],
    archivedThreads: [
      thread({ id: "shared", updatedAt: 200 }),
      thread({ id: "archived-only", updatedAt: 100 }),
    ],
    identity,
    generatedAt: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(overlapSnapshot.summary.activeThreadCount, 1);
  assert.equal(overlapSnapshot.summary.archivedThreadCount, 1);
  assert.equal(overlapSnapshot.summary.taskCount, 2);
  assert.equal(overlapSnapshot.aggregate.counts.total, 2);
  assert.match(overlapSnapshot.snapshotId, /^[0-9a-f]{64}$/u);
  assert.equal(
    overlapSnapshot.aggregate.lanes.flatMap(({ tasks }) => tasks)
      .find(({ id }) => id === "shared").archived,
    false,
  );
  assert.throws(
    () => buildReadonlyBoardSnapshot({ activeThreads: [], archivedThreads: [], identity: { ...identity, outboundMethods: ["turn/start"] } }),
    (error) => error.code === "EREADONLYMETHOD",
  );
});

test("readonly projection rejects duplicates within either catalog", () => {
  assert.throws(
    () => buildReadonlyBoardSnapshot({
      activeThreads: [thread({ id: "active-duplicate" }), thread({ id: "active-duplicate" })],
      archivedThreads: [],
      identity,
    }),
    (error) => error.code === "ETHREADDUPLICATE",
  );
  assert.throws(
    () => buildReadonlyBoardSnapshot({
      activeThreads: [],
      archivedThreads: [thread({ id: "archived-duplicate" }), thread({ id: "archived-duplicate" })],
      identity,
    }),
    (error) => error.code === "ETHREADDUPLICATE",
  );
});

test("readonly projection identifies equal snapshots deterministically", () => {
  const buildSnapshot = (updatedAt, generatedAt = "2026-08-11T00:00:00.000Z") => buildReadonlyBoardSnapshot({
    activeThreads: [thread({ updatedAt })],
    archivedThreads: [],
    identity,
    generatedAt,
  });

  const first = buildSnapshot(200);
  const second = buildSnapshot(200, "2026-08-11T00:00:30.000Z");
  const changed = buildSnapshot(201);

  assert.match(first.snapshotId, /^[0-9a-f]{64}$/u);
  assert.notEqual(first.generatedAt, second.generatedAt);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.notEqual(first.snapshotId, changed.snapshotId);
});

test("readonly projection orders tied projects independently of catalog order", () => {
  const firstThread = thread({ id: "thread-one", cwd: "C:\\one\\same" });
  const secondThread = thread({ id: "thread-two", cwd: "D:\\two\\same" });
  const buildSnapshot = (activeThreads) => buildReadonlyBoardSnapshot({
    activeThreads,
    archivedThreads: [],
    identity,
    generatedAt: "2026-08-11T00:00:00.000Z",
  });

  const forward = buildSnapshot([firstThread, secondThread]);
  const reversed = buildSnapshot([secondThread, firstThread]);

  assert.deepEqual(
    forward.projects.map(({ id }) => id),
    reversed.projects.map(({ id }) => id),
  );
  assert.equal(forward.snapshotId, reversed.snapshotId);
});

test("local lane overrides change only the Projectboard projection and snapshot identity", () => {
  const base = buildReadonlyBoardSnapshot({
    activeThreads: [thread()],
    archivedThreads: [],
    identity,
    generatedAt: "2026-08-11T00:00:00.000Z",
  });
  const moved = buildReadonlyBoardSnapshot({
    activeThreads: [thread()],
    archivedThreads: [],
    identity,
    laneOverrides: [{ threadId: "thread-1", laneId: "planned" }],
    generatedAt: "2026-08-11T00:00:00.000Z",
  });

  assert.equal(base.aggregate.lanes.find(({ id }) => id === "inbox").tasks.length, 1);
  assert.equal(moved.aggregate.lanes.find(({ id }) => id === "inbox").tasks.length, 0);
  const task = moved.aggregate.lanes.find(({ id }) => id === "planned").tasks[0];
  assert.equal(task.threadId, "thread-1");
  assert.equal(task.state, "planned");
  assert.equal(task.sourceStatus, "idle", "local organization must not rewrite Codex source status");
  assert.notEqual(moved.snapshotId, base.snapshotId);
});
