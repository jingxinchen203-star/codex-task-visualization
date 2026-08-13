import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  buildDesktopCatalogExpression,
  readDesktopThreadCatalog,
  validateDesktopCatalog,
} from "../../src/phase-1/desktop-bridge.js";
import { INTERACTIVE_THREAD_SOURCE_KINDS } from "../../src/phase-1/catalog-policy.js";

function thread(id, status = { type: "idle" }) {
  return {
    id,
    name: `Task ${id}`,
    preview: `Preview ${id}`,
    cwd: "C:\\Work\\Board",
    createdAt: 1,
    updatedAt: 2,
    status,
    turns: [{ private: true }],
    path: "private.jsonl",
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function executeExpression(expression, respond) {
  const listeners = new Set();
  const context = {
    structuredClone,
    setTimeout,
    clearTimeout,
    Date,
    Error,
    Promise,
    Set,
    globalThis: null,
    addEventListener(type, listener) {
      assert.equal(type, "message");
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "message");
      listeners.delete(listener);
    },
  };
  const sent = [];
  context.electronBridge = {
    async sendMessageFromView(message) {
      sent.push(message);
      const response = await respond(message);
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener({ data: response });
      });
    },
  };
  context.globalThis = context;
  return {
    sent,
    listeners,
    result: vm.runInNewContext(expression, context, { timeout: 1_000 }),
  };
}

test("desktop bridge requests only account identity and paginated thread metadata", async () => {
  const execution = executeExpression(
    buildDesktopCatalogExpression([], { requestTimeoutMs: 100, maxPages: 4 }),
    async ({ hostId, request }) => {
      let result;
      if (request.method === "account/read") {
        result = {
          account: { type: "chatgpt", email: "must-not-escape@example.com" },
          requiresOpenaiAuth: true,
        };
      } else if (!request.params.archived) {
        result = request.params.cursor === null
          ? {
            data: Array.from({ length: 100 }, (_, index) => thread(`active-${index + 1}`)),
            nextCursor: "active-2",
          }
          : { data: [thread("active-101")], nextCursor: null };
      } else {
        result = request.params.cursor === null
          ? {
            data: Array.from({ length: 100 }, (_, index) => thread(`archived-${index + 1}`)),
            nextCursor: "archived-2",
          }
          : { data: [thread("archived-101")], nextCursor: null };
      }
      return { type: "mcp-response", hostId, message: { id: request.id, result } };
    },
  );
  const catalog = await execution.result;

  assert.deepEqual(catalog.accountType, "chatgpt");
  assert.equal(catalog.activeThreads.length, 101);
  assert.equal(catalog.archivedThreads.length, 101);
  assert.deepEqual(plain(catalog.outboundMethods), ["account/read", "thread/list", "thread/list", "thread/list", "thread/list"]);
  assert.equal(JSON.stringify(catalog).includes("must-not-escape"), false);
  assert.equal("turns" in catalog.activeThreads[0], false);
  assert.equal("path" in catalog.activeThreads[0], false);
  assert.equal(execution.listeners.size, 0);
  assert.equal(execution.sent.every(({ hostId }) => hostId === "local"), true);
  assert.equal(execution.sent.every(({ priority }) => priority === "interactive"), true);
  assert.deepEqual(plain(execution.sent[0].request.params), { refreshToken: false });
  const threadListRequests = execution.sent.filter(({ request }) => request.method === "thread/list");
  assert.deepEqual(plain(threadListRequests.map(({ request }) => ({
    archived: request.params.archived,
    cursor: request.params.cursor,
  }))), [
    { archived: false, cursor: null },
    { archived: false, cursor: "active-2" },
    { archived: true, cursor: null },
    { archived: true, cursor: "archived-2" },
  ]);
  assert.equal(threadListRequests.every(({ request }) => plain(request.params.sourceKinds).length === 0), true);
  for (const forbidden of ["initialize", "thread/read", "thread/start", "turn/start", "thread/archive", "thread/delete"]) {
    assert.equal(execution.sent.some(({ request }) => request.method === forbidden), false);
  }
});

test("desktop bridge validates its fixed local host and returned catalog", async () => {
  assert.deepEqual(INTERACTIVE_THREAD_SOURCE_KINDS, []);
  assert.equal(Object.isFrozen(INTERACTIVE_THREAD_SOURCE_KINDS), true);
  const expression = buildDesktopCatalogExpression([], { requestTimeoutMs: 100, maxPages: 4 });
  assert.match(expression, /"sourceKinds":\[\]/u);
  assert.throws(() => buildDesktopCatalogExpression([""], {}), /sourceKinds/u);
  assert.throws(() => buildDesktopCatalogExpression(["vscode"], { hostId: "remote" }), /hostId/u);
  assert.throws(() => buildDesktopCatalogExpression(["vscode"], { requestTimeoutMs: 0 }), /positive integer/u);
  assert.throws(
    () => validateDesktopCatalog({
      accountType: "chatgpt",
      requiresOpenaiAuth: true,
      activeThreads: [],
      archivedThreads: [],
      outboundMethods: ["turn/start"],
    }),
    /read-only allowlist/u,
  );
  assert.throws(
    () => validateDesktopCatalog({
      accountType: "chatgpt",
      requiresOpenaiAuth: true,
      activeThreads: [],
      archivedThreads: [],
      outboundMethods: ["thread/list", "thread/list", "thread/list"],
    }),
    /complete read-only request evidence/u,
  );

  const peer = {
    async request(method, params, meta) {
      assert.equal(method, "Runtime.evaluate");
      assert.equal(params.awaitPromise, true);
      assert.equal(params.returnByValue, true);
      assert.equal(meta.sessionId, "session-1");
      return {
        result: {
          value: {
            accountType: "chatgpt",
            requiresOpenaiAuth: true,
            activeThreads: [thread("one")],
            archivedThreads: [],
            outboundMethods: ["account/read", "thread/list", "thread/list"],
          },
        },
      };
    },
  };
  const catalog = await readDesktopThreadCatalog(peer, "session-1", ["vscode"]);
  assert.equal(catalog.activeThreads[0].id, "one");
});
