import test from "node:test";
import assert from "node:assert/strict";
import { readReadonlyThreadCatalog } from "../../src/phase-1/read-catalog.js";

function cleanClose() {
  return {
    settlement: { code: 0, signal: null, error: null, unsettled: false },
    disposal: { cleanup: { attempted: true, ok: true, error: null } },
    stderr: { text: "", bytes: 0, truncated: false },
  };
}

test("thread catalog uses only the read-only App Server allowlist and closes before returning", async () => {
  const outbound = [];
  const peer = {
    outbound,
    async request(method, params) {
      outbound.push({ method, params });
      if (method === "initialize") return { userAgent: "test" };
      if (method === "account/read") return { account: { type: "chatgpt", email: "must-not-escape@example.com" }, requiresOpenaiAuth: true };
      if (method === "thread/list") {
        return params.archived
          ? { data: [{ id: "archived" }], nextCursor: null }
          : { data: [{ id: "active" }], nextCursor: null };
      }
      throw new Error(`unexpected method: ${method}`);
    },
    async notify(method, params) { outbound.push({ method, params }); },
  };
  let closed = false;
  let openOptions = null;
  const result = await readReadonlyThreadCatalog(
    { launchRecipe: { kind: "private-staged-snapshot" } },
    ["vscode"],
    {
      open: async (_candidate, options) => {
        openOptions = options;
        return { peer, close: async () => { closed = true; return cleanClose(); } };
      },
      list: async (value, archived, sourceKinds) => {
        const page = await value.request("thread/list", { archived, sourceKinds });
        return page.data;
      },
    },
  );

  assert.equal(closed, true);
  assert.deepEqual(openOptions, {
    appServerArguments: ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
  });
  assert.deepEqual(result, {
    accountType: "chatgpt",
    requiresOpenaiAuth: true,
    activeThreads: [{ id: "active" }],
    archivedThreads: [{ id: "archived" }],
    outboundMethods: ["initialize", "initialized", "account/read", "thread/list", "thread/list"],
  });
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
  assert.deepEqual(outbound.map(({ method }) => method), result.outboundMethods);
  assert.deepEqual(outbound[0].params, {
    clientInfo: {
      name: "codex_projectboard_phase1_readonly",
      title: "Codex Projectboard Phase 1 (Read Only)",
      version: "0.2.0",
    },
  });
});

test("thread catalog rejects forbidden calls and unhealthy App Server settlement", async () => {
  const peer = {
    outbound: [],
    async request(method) {
      this.outbound.push({ method });
      if (method === "initialize") return {};
      if (method === "account/read") return { account: null, requiresOpenaiAuth: true };
      return { data: [], nextCursor: null };
    },
    async notify(method) { this.outbound.push({ method }); },
  };
  await assert.rejects(
    readReadonlyThreadCatalog({}, ["vscode"], {
      open: async () => ({ peer, close: async () => ({ ...cleanClose(), settlement: { code: 1, signal: null, error: null, unsettled: false } }) }),
      list: async (value) => {
        await value.request("turn/start", {});
        return [];
      },
    }),
    (error) => error.code === "EREADONLYMETHOD" || error.code === "EAPPSERVERLIFECYCLE",
  );
});
