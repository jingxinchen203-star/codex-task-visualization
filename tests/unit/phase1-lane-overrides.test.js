import test from "node:test";
import assert from "node:assert/strict";
import {
  loadLaneOverrides,
  persistLaneOverrides,
  upsertLaneOverride,
  validateLaneOverrides,
} from "../../src/phase-1/lane-overrides.js";

test("local lane overrides are canonical, unique, and deterministically upserted", () => {
  const overrides = upsertLaneOverride([
    { threadId: "thread-b", laneId: "review" },
  ], { threadId: "thread-a", laneId: "planned" });

  assert.deepEqual(overrides, [
    { threadId: "thread-a", laneId: "planned" },
    { threadId: "thread-b", laneId: "review" },
  ]);
  assert.equal(Object.isFrozen(overrides), true);
  assert.deepEqual(upsertLaneOverride(overrides, { threadId: "thread-a", laneId: "done" }), [
    { threadId: "thread-a", laneId: "done" },
    { threadId: "thread-b", laneId: "review" },
  ]);
  assert.throws(
    () => validateLaneOverrides([{ threadId: "thread-a", laneId: "planned" }, { threadId: "thread-a", laneId: "done" }]),
    /unique thread IDs/u,
  );
  assert.throws(() => upsertLaneOverride([], { threadId: "thread-a", laneId: "unknown" }), /canonical five lanes/u);
});

test("local lane override file loads schema v1 and treats a missing file as empty", async () => {
  const missing = await loadLaneOverrides("C:\\state\\missing.json", {
    read: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert.deepEqual(missing, []);

  const loaded = await loadLaneOverrides("C:\\state\\lane.json", {
    read: async () => Buffer.from(JSON.stringify({
      schemaVersion: 1,
      overrides: [{ threadId: "thread-1", laneId: "running" }],
    })),
  });
  assert.deepEqual(loaded, [{ threadId: "thread-1", laneId: "running" }]);
  await assert.rejects(
    loadLaneOverrides("C:\\state\\lane.json", { read: async () => "{}" }),
    /unsupported schema/u,
  );
});

test("local lane override persistence writes a temporary file then atomically replaces the target", async () => {
  const calls = [];
  const target = "C:\\state\\lane-overrides.v1.json";
  await persistLaneOverrides(target, [{ threadId: "thread-1", laneId: "planned" }], {
    makeDirectory: async (...args) => calls.push(["mkdir", ...args]),
    write: async (...args) => calls.push(["write", ...args]),
    replace: async (...args) => calls.push(["rename", ...args]),
    remove: async (...args) => calls.push(["unlink", ...args]),
    uniqueId: () => "fixed",
  });

  assert.deepEqual(calls.map(([operation]) => operation), ["mkdir", "write", "rename"]);
  assert.equal(calls[1][1], "C:\\state\\.lane-overrides-fixed.tmp");
  assert.match(calls[1][2], /"laneId": "planned"/u);
  assert.deepEqual(calls[1][3], { encoding: "utf8", flag: "wx", mode: 0o600 });
  assert.deepEqual(calls[2].slice(1), ["C:\\state\\.lane-overrides-fixed.tmp", target]);
});
