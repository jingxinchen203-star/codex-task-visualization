import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { JsonlPeer, initializeStable } from "../../src/app-server/jsonl-peer.js";
import { listAllThreadMetadata, openAppServer, probeAppServerIdentity } from "../../src/app-server/probe-readonly.js";

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function outcomeWithin(promise, timeoutMs = 100) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve({ kind: "timeout" });
    }, timeoutMs);
    promise.then(
      (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ kind: "resolved", value });
      },
      (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ kind: "rejected", error });
      },
    );
  });
}

function collectJsonLines(stream) {
  const messages = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  return messages;
}

function writeMessage(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function fakePeer(handler) {
  return {
    outbound: [],
    async request(method, params) {
      this.outbound.push({ id: this.outbound.length + 1, method, params });
      return handler(method, params);
    },
    async notify(method, params) {
      this.outbound.push({ method, params });
    },
  };
}

function scriptedStagedPrepare(script, {
  stderrText = "",
  settleOnStdinEnd = false,
  terminateError = null,
} = {}) {
  const state = {
    prepareArgument: null,
    spawnArguments: null,
    terminateCalled: false,
    disposeCalled: false,
    settled: false,
    order: [],
  };
  let resolveSettlement;
  const settlement = new Promise((resolve) => { resolveSettlement = resolve; });

  const prepare = async (recipe) => {
    state.prepareArgument = recipe;
    return {
      execution: Object.freeze({ digest: "d".repeat(64), files: Object.freeze([]) }),
      binding: Object.freeze({ kind: "private-staged-snapshot", exact: true, files: Object.freeze([]) }),
      async spawn(args) {
        state.spawnArguments = args;
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let inputBuffer = "";
        stdin.setEncoding("utf8");
        stdin.on("data", (chunk) => {
          inputBuffer += chunk;
          let newline;
          while ((newline = inputBuffer.indexOf("\n")) >= 0) {
            const line = inputBuffer.slice(0, newline);
            inputBuffer = inputBuffer.slice(newline + 1);
            if (!line) continue;
            const message = JSON.parse(line);
            script(message, (response) => writeMessage(stdout, response));
          }
        });
        const settle = (reason) => {
          if (state.settled) return;
          state.settled = true;
          state.order.push(reason, "settle");
          stdout.end();
          stderr.end();
          resolveSettlement(Object.freeze({ code: 0, signal: null, error: null, unsettled: false }));
        };
        if (settleOnStdinEnd) stdin.once("finish", () => settle("stdinEnd"));
        if (stderrText) stderr.end(stderrText);
        return Object.freeze({
          stdin,
          stdout,
          stderr,
          pid: 123,
          settlement,
          terminate: async () => {
            if (!state.terminateCalled) {
              state.terminateCalled = true;
              stdin.end();
              settle("terminate");
            }
            if (terminateError) throw terminateError;
            return { requested: true };
          },
        });
      },
      async dispose() {
        assert.equal(state.settled, true, "dispose must follow child settlement");
        state.disposeCalled = true;
        state.order.push("dispose");
        return { cleanup: { ok: true }, postVerification: { ok: true } };
      },
    };
  };
  return { prepare, state };
}

function delayedLifecyclePrepare({
  settleDelayMs = null,
  settlementOutcome = { code: 0, signal: null, error: null, unsettled: false },
  disposeError = null,
} = {}) {
  const state = { terminateCount: 0, disposeCount: 0, settled: false };
  let resolveSettlement;
  const settlement = new Promise((resolve) => { resolveSettlement = resolve; });
  const prepare = async () => ({
    execution: Object.freeze({ digest: "d".repeat(64), files: Object.freeze([]) }),
    binding: Object.freeze({ kind: "private-staged-snapshot", exact: true, files: Object.freeze([]) }),
    async spawn() {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return Object.freeze({
        stdin,
        stdout,
        stderr,
        settlement,
        terminate: async () => {
          state.terminateCount += 1;
          if (settleDelayMs !== null && state.terminateCount === 1) {
            setTimeout(() => {
              state.settled = true;
              stdout.end();
              stderr.end();
              resolveSettlement(Object.freeze(settlementOutcome));
            }, settleDelayMs);
          }
          return { requested: true };
        },
      });
    },
    async dispose() {
      assert.equal(state.settled, true, "deferred dispose must follow final child settlement");
      state.disposeCount += 1;
      if (disposeError) throw disposeError;
      return { cleanup: { attempted: true, ok: true, error: null }, postVerification: { ok: true } };
    },
  });
  return { prepare, state };
}

test("JsonlPeer frames requests and distinguishes responses, server requests, and notifications", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent = collectJsonLines(output);
  const peer = new JsonlPeer(input, output);

  const list = peer.request("thread/list", { limit: 100 });
  const turn = peer.request("turn/start", { threadId: "thread-1" });
  await nextTurn();
  assert.deepEqual(sent.map(({ method }) => method), ["thread/list", "turn/start"]);
  assert.equal(sent.some((message) => "jsonrpc" in message), false);

  writeMessage(input, { id: 1, result: { data: [] } });
  writeMessage(input, { id: 77, method: "item/commandExecution/requestApproval", params: { command: "dir" } });
  writeMessage(input, { method: "thread/updated", params: { threadId: "thread-1" } });
  writeMessage(input, { id: 2, error: { code: -32001, message: "turn conflict", data: { activeTurnId: "turn-9" } } });

  assert.deepEqual(await list, { data: [] });
  const conflict = await turn.catch((error) => error);
  assert.equal(conflict.message, "turn conflict");
  assert.deepEqual(conflict.rpc, { code: -32001, message: "turn conflict", data: { activeTurnId: "turn-9" } });
  assert.deepEqual(peer.serverRequests, [{ id: 77, method: "item/commandExecution/requestApproval", params: { command: "dir" } }]);
  assert.deepEqual(peer.notifications, [{ method: "thread/updated", params: { threadId: "thread-1" } }]);
  assert.deepEqual(peer.outbound.map(({ method }) => method), ["thread/list", "turn/start"]);

  await peer.respond(77, { decision: "decline" });
  await nextTurn();
  assert.deepEqual(sent.at(-1), { id: 77, result: { decision: "decline" } });
});

test("JsonlPeer emits orphan responses without confusing them for requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonlPeer(input, output);
  const orphans = [];
  peer.on("orphanResponse", (message) => orphans.push(message));

  writeMessage(input, { id: 404, result: { ignored: true } });
  await nextTurn();
  assert.deepEqual(orphans, [{ id: 404, result: { ignored: true } }]);
});

test("malformed JSON fails all pending requests once and emits a protocol error", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonlPeer(input, output);
  const protocolErrors = [];
  peer.on("protocolError", (error) => protocolErrors.push(error));
  const first = peer.request("thread/list");
  const second = peer.request("account/read");

  input.write("{not-json}\n");
  input.emit("error", new Error("later stream error"));
  const outcomes = await Promise.all([first.catch((error) => error), second.catch((error) => error)]);
  assert.equal(protocolErrors.length, 1);
  assert.match(protocolErrors[0].message, /JSON/u);
  assert.deepEqual(outcomes.map(({ message }) => message), [protocolErrors[0].message, protocolErrors[0].message]);
  await assert.rejects(peer.request("thread/list"), /protocol|closed|failed/u);
});

test("newline-free input beyond the configured record limit fails closed", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonlPeer(input, output, { maxInboundRecordBytes: 16 });
  const pending = peer.request("thread/list", {}, 50);

  input.write("x".repeat(17));

  await assert.rejects(pending, (error) => error.code === "EPROTOCOL" && /record.*limit/u.test(error.message));
  assert.equal(peer.pendingCount, 0);
});

test("a complete oversized JSONL record fails closed before it is accepted", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonlPeer(input, output, { maxInboundRecordBytes: 32 });
  const pending = peer.request("thread/list", {}, 50);

  writeMessage(input, { id: 1, result: { value: "x".repeat(64) } });

  await assert.rejects(pending, (error) => error.code === "EPROTOCOL" && /record.*limit/u.test(error.message));
  assert.equal(peer.pendingCount, 0);
});

test("invalid protocol messages fail closed", async () => {
  for (const invalid of [null, [], { result: {} }, { id: 1 }, { id: 1, result: {}, error: {} }, { method: 3 }]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonlPeer(input, output);
    const pending = peer.request("thread/list");
    writeMessage(input, invalid);
    await assert.rejects(pending, /protocol/u);
  }
});

test("timeouts remove pending requests and late responses become orphans", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonlPeer(input, output);
  const orphans = [];
  peer.on("orphanResponse", (message) => orphans.push(message));

  await assert.rejects(peer.request("thread/list", {}, 10), /timed out/u);
  writeMessage(input, { id: 1, result: { data: [] } });
  await nextTurn();
  assert.equal(peer.pendingCount, 0);
  assert.deepEqual(orphans, [{ id: 1, result: { data: [] } }]);
});

test("input close and output write errors reject pending work without uncaught error events", async () => {
  {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonlPeer(input, output);
    const pending = peer.request("thread/list");
    input.end();
    await assert.rejects(pending, /input.*closed/u);
  }
  {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error("write exploded")); },
    });
    const peer = new JsonlPeer(input, output);
    await assert.rejects(peer.request("thread/list"), /write exploded/u);
  }
});

test("notify and respond writes settle on output error or close even when write callbacks never fire", async (t) => {
  for (const operation of ["notify", "respond"]) {
    for (const terminalEvent of ["error", "close"]) {
      await t.test(`${operation} rejects on output ${terminalEvent}`, async () => {
        const input = new PassThrough();
        const callbacks = [];
        const output = new Writable({
          write(_chunk, _encoding, callback) { callbacks.push(callback); },
        });
        const peer = new JsonlPeer(input, output);
        const pending = operation === "notify"
          ? peer.notify("initialized", {})
          : peer.respond(41, { decision: "decline" });
        let settlementCount = 0;
        pending.then(() => { settlementCount += 1; }, () => { settlementCount += 1; });
        await nextTurn();
        assert.equal(callbacks.length, 1);

        if (terminalEvent === "error") output.emit("error", new Error("output boom"));
        else output.emit("close");
        const outcome = await outcomeWithin(pending);
        assert.equal(outcome.kind, "rejected");
        assert.match(outcome.error.message, terminalEvent === "error" ? /output boom/u : /output closed/u);
        callbacks[0](null);
        await nextTurn();
        assert.equal(settlementCount, 1);
        assert.equal(peer.activeWriteCount, 0);
      });
    }
  }
});

test("write callback and output error races settle once and leave no active write", async () => {
  const input = new PassThrough();
  let writeCallback;
  const output = new Writable({
    write(_chunk, _encoding, callback) { writeCallback = callback; },
  });
  const peer = new JsonlPeer(input, output);
  const notification = peer.notify("initialized", {});
  let settlementCount = 0;
  notification.then(() => { settlementCount += 1; }, () => { settlementCount += 1; });
  await nextTurn();

  writeCallback(null);
  output.emit("error", new Error("late output error"));
  assert.deepEqual(await outcomeWithin(notification), { kind: "resolved", value: undefined });
  await nextTurn();
  assert.equal(settlementCount, 1);
  assert.equal(peer.activeWriteCount, 0);
  await assert.rejects(peer.notify("later", {}), /late output error/u);
});

test("request output failure rejects RPC and write state once without leaks", async () => {
  const input = new PassThrough();
  let writeCallback;
  const output = new Writable({
    write(_chunk, _encoding, callback) { writeCallback = callback; },
  });
  const peer = new JsonlPeer(input, output);
  const request = peer.request("thread/list", {}, 1_000);
  let rejectionCount = 0;
  request.catch(() => { rejectionCount += 1; });
  await nextTurn();

  output.emit("error", new Error("request output failed"));
  writeCallback(new Error("late callback failure"));
  await assert.rejects(request, /request output failed/u);
  await nextTurn();
  assert.equal(rejectionCount, 1);
  assert.equal(peer.pendingCount, 0);
  assert.equal(peer.activeWriteCount, 0);
});

test("queued writes preserve order across output backpressure", async () => {
  const input = new PassThrough();
  const chunks = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      setImmediate(callback);
    },
  });
  const peer = new JsonlPeer(input, output);
  await Promise.all([peer.notify("first", { n: 1 }), peer.notify("second", { n: 2 })]);
  assert.deepEqual(chunks.map((line) => JSON.parse(line).method), ["first", "second"]);
});

test("a request that times out in the write queue is never transmitted later", async () => {
  const input = new PassThrough();
  const chunks = [];
  const callbacks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callbacks.push(callback);
    },
  });
  const peer = new JsonlPeer(input, output);
  const blocker = peer.notify("blocker", {});
  await nextTurn();

  const expired = peer.request("thread/list", {}, 10);
  await assert.rejects(expired, (error) => error.code === "ETIMEDOUT");
  callbacks[0]();
  await blocker;
  await nextTurn();

  const methods = chunks.map((line) => JSON.parse(line).method);
  for (const callback of callbacks.slice(1)) callback();
  assert.deepEqual(methods, ["blocker"]);
  assert.equal(peer.pendingCount, 0);
});

test("request serialization failures reject the registered request without leaking pending state", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonlPeer(input, output);
  const circular = {};
  circular.self = circular;

  let request;
  assert.doesNotThrow(() => { request = peer.request("thread/list", circular); });
  await assert.rejects(request, /circular|serializ/u);
  assert.equal(peer.pendingCount, 0);
});

test("initializeStable performs one initialize handshake and one initialized notification", async () => {
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const peer = fakePeer(async (method, params) => {
    assert.equal(method, "initialize");
    assert.deepEqual(params, {
      clientInfo: { name: "codex_projectboard_phase0", title: "Codex Projectboard Phase 0", version: "0.1.0" },
    });
    return response;
  });

  const first = initializeStable(peer);
  await assert.rejects(initializeStable(peer), /already/u);
  release({ userAgent: "codex-test" });
  assert.deepEqual(await first, { userAgent: "codex-test" });
  assert.deepEqual(peer.outbound.map(({ method }) => method), ["initialize", "initialized"]);
  assert.deepEqual(peer.outbound[1].params, {});
  await assert.rejects(initializeStable(peer), /already/u);
});

test("initializeStable validates an optional client identity before consuming the peer", async () => {
  const peer = fakePeer(async (_method, params) => params.clientInfo);
  await assert.rejects(
    initializeStable(peer, { name: "phase1", title: "Read only", version: "" }),
    /clientInfo/u,
  );
  assert.equal(peer.outbound.length, 0);
  assert.deepEqual(await initializeStable(peer, {
    name: "codex_projectboard_phase1_readonly",
    title: "Codex Projectboard Phase 1 (Read Only)",
    version: "0.2.0",
  }), {
    name: "codex_projectboard_phase1_readonly",
    title: "Codex Projectboard Phase 1 (Read Only)",
    version: "0.2.0",
  });
  assert.deepEqual(peer.outbound.map(({ method }) => method), ["initialize", "initialized"]);
});

test("initializeStable rejects if initialized notification loses its write callback", async () => {
  const input = new PassThrough();
  let writes = 0;
  let output;
  output = new Writable({
    write(chunk, _encoding, callback) {
      writes += 1;
      const message = JSON.parse(chunk.toString("utf8"));
      if (writes === 1) {
        callback();
        setImmediate(() => writeMessage(input, { id: message.id, result: { userAgent: "codex-test" } }));
      } else {
        setImmediate(() => output.emit("error", new Error("initialized notification failed")));
      }
    },
  });
  const peer = new JsonlPeer(input, output);

  const outcome = await outcomeWithin(initializeStable(peer));
  assert.equal(outcome.kind, "rejected");
  assert.match(outcome.error.message, /initialized notification failed/u);
  assert.equal(peer.activeWriteCount, 0);
});

test("listAllThreadMetadata paginates with generated source kinds and strips full thread data", async () => {
  const sourceKinds = ["futureKind", "anotherGeneratedKind"];
  const calls = [];
  const peer = fakePeer(async (method, params) => {
    calls.push({ method, params });
    if (params.cursor === null) {
      return {
        data: [{ id: "a", name: "Alpha", preview: "A", cwd: "C:\\A", createdAt: 1, updatedAt: 2, status: { type: "idle" }, turns: [{ secret: true }], source: "futureKind" }],
        nextCursor: "cursor-2",
      };
    }
    return {
      data: [{ id: "b", name: null, preview: "B", cwd: "C:\\B", createdAt: 3, updatedAt: 4, status: { type: "active", activeFlags: [] }, path: "private.jsonl" }],
      nextCursor: null,
    };
  });

  const metadata = await listAllThreadMetadata(peer, true, sourceKinds);
  assert.deepEqual(calls, [
    { method: "thread/list", params: { archived: true, cursor: null, limit: 100, sortKey: "updated_at", sortDirection: "desc", sourceKinds } },
    { method: "thread/list", params: { archived: true, cursor: "cursor-2", limit: 100, sortKey: "updated_at", sortDirection: "desc", sourceKinds } },
  ]);
  assert.deepEqual(metadata, [
    { id: "a", name: "Alpha", preview: "A", cwd: "C:\\A", createdAt: 1, updatedAt: 2, status: { type: "idle" } },
    { id: "b", name: null, preview: "B", cwd: "C:\\B", createdAt: 3, updatedAt: 4, status: { type: "active", activeFlags: [] } },
  ]);
  assert.equal("turns" in metadata[0], false);
  assert.equal("path" in metadata[1], false);
});

test("listAllThreadMetadata accepts an empty source filter for the interactive catalog", async () => {
  const peer = fakePeer(async () => ({ data: [], nextCursor: null }));

  assert.deepEqual(await listAllThreadMetadata(peer, false, []), []);
  assert.deepEqual(peer.outbound[0].params.sourceKinds, []);
});

test("listAllThreadMetadata rejects invalid source kinds, malformed pages, and repeated cursors", async () => {
  const unused = fakePeer(async () => ({ data: [], nextCursor: null }));
  await assert.rejects(listAllThreadMetadata(unused, false, ["", "ok"]), {
    name: "TypeError",
    message: "sourceKinds must contain unique nonempty strings when supplied",
  });

  const malformed = fakePeer(async () => ({ data: {}, nextCursor: null }));
  await assert.rejects(listAllThreadMetadata(malformed, false, ["generated"]), /page/u);

  const repeated = fakePeer(async () => ({ data: [], nextCursor: "same" }));
  await assert.rejects(listAllThreadMetadata(repeated, false, ["generated"]), /cursor/u);
  assert.equal(repeated.outbound.length, 2);
});

test("listAllThreadMetadata caps pagination even when every cursor is unique", async () => {
  let page = 0;
  const endless = fakePeer(async () => {
    page += 1;
    if (page > 1_000) throw new Error("test peer exceeded expected page cap");
    return { data: [], nextCursor: `cursor-${page}` };
  });
  await assert.rejects(listAllThreadMetadata(endless, false, ["generated"]), /page limit/u);
  assert.equal(page, 1_000);
});

test("probeAppServerIdentity uses only the read-only allowlist and always closes", async () => {
  const peer = fakePeer(async (method, params) => {
    if (method === "initialize") return { userAgent: "codex-test", platformOs: "windows" };
    if (method === "account/read") return { account: { type: "chatgpt", email: "private@example.com" }, requiresOpenaiAuth: true };
    if (method === "thread/list") return { data: [], nextCursor: null };
    throw new Error(`unexpected method: ${method}`);
  });
  let closed = false;
  const open = async () => ({
    peer,
    close: async () => {
      closed = true;
      return {
        settlement: { code: 0, signal: null, error: null, unsettled: false },
        disposal: { cleanup: { attempted: true, ok: true, error: null } },
        stderr: { text: "", bytes: 0, truncated: false },
      };
    },
  });

  const result = await probeAppServerIdentity({ launchRecipe: { kind: "recipe" } }, ["generated"], { open });
  assert.equal(closed, true);
  assert.deepEqual(result, {
    initialized: true,
    accountType: "chatgpt",
    requiresOpenaiAuth: true,
    activeCount: 0,
    archivedCount: 0,
    outboundMethods: ["initialize", "initialized", "account/read", "thread/list", "thread/list"],
    lifecycle: { code: 0, signal: null, stderrBytes: 0, stderrTruncated: false, cleanupOk: true },
  });
  const methods = peer.outbound.map(({ method }) => method);
  assert.deepEqual(methods, ["initialize", "initialized", "account/read", "thread/list", "thread/list"]);
  for (const forbidden of ["thread/read", "thread/start", "turn/start", "thread/archive", "thread/delete"]) {
    assert.equal(methods.includes(forbidden), false);
  }
  assert.deepEqual(peer.outbound.find(({ method }) => method === "account/read").params, { refreshToken: false });
});

test("probeAppServerIdentity rejects unhealthy close lifecycle with safe evidence", async (t) => {
  const scenarios = [
    {
      name: "nonzero exit",
      settlement: { code: 7, signal: null, error: null, unsettled: false },
      cleanup: { attempted: true, ok: true, error: null },
      expected: { code: 7, settlementError: null, cleanupOk: true },
    },
    {
      name: "child error",
      settlement: {
        code: null,
        signal: null,
        error: Object.assign(new Error("server crashed"), { code: "ECRASH", privatePath: "C:\\private\\rollout.jsonl" }),
        unsettled: false,
      },
      cleanup: { attempted: true, ok: true, error: null },
      expected: { code: null, settlementError: { name: "Error", code: "ECRASH", message: "server crashed" }, cleanupOk: true },
    },
    {
      name: "cleanup failure",
      settlement: { code: 0, signal: null, error: null, unsettled: false },
      cleanup: {
        attempted: true,
        ok: false,
        error: Object.assign(new Error("cleanup failed"), { code: "ECLEANUP", privatePath: "C:\\private\\stage" }),
      },
      expected: { code: 0, settlementError: null, cleanupOk: false },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const peer = fakePeer(async (method) => {
        if (method === "initialize") return { userAgent: "codex-test" };
        if (method === "account/read") return { account: null, requiresOpenaiAuth: true };
        if (method === "thread/list") return { data: [], nextCursor: null };
        throw new Error(`unexpected method: ${method}`);
      });
      const open = async () => ({
        peer,
        close: async () => ({
          settlement: scenario.settlement,
          disposal: { cleanup: scenario.cleanup },
          stderr: { text: "private stderr must not escape", bytes: 31, truncated: true },
        }),
      });

      const error = await probeAppServerIdentity(
        { launchRecipe: { kind: "recipe" } },
        ["generated"],
        { open },
      ).catch((value) => value);
      assert.equal(error.code, "EAPPSERVERLIFECYCLE");
      assert.match(error.message, /lifecycle/u);
      assert.equal(error.lifecycle.settled, true);
      assert.equal(error.lifecycle.code, scenario.expected.code);
      assert.deepEqual(error.lifecycle.settlementError, scenario.expected.settlementError);
      assert.equal(error.lifecycle.cleanupOk, scenario.expected.cleanupOk);
      assert.equal(error.lifecycle.stderrBytes, 31);
      assert.equal(error.lifecycle.stderrTruncated, true);
      assert.equal(JSON.stringify(error.lifecycle).includes("private"), false);
      assert.equal("initialized" in error, false);
    });
  }
});

test("probe preserves unhealthy close evidence when an RPC already failed", async () => {
  const peer = fakePeer(async (method) => {
    if (method === "initialize") throw new Error("handshake failed");
    throw new Error(`unexpected method: ${method}`);
  });
  const open = async () => ({
    peer,
    close: async () => ({
      settlement: { code: 7, signal: null, error: null, unsettled: false },
      disposal: { cleanup: { attempted: true, ok: true, error: null } },
      stderr: { text: "", bytes: 0, truncated: false },
    }),
  });

  const error = await probeAppServerIdentity(
    { launchRecipe: { kind: "recipe" } },
    ["generated"],
    { open },
  ).catch((value) => value);
  assert.equal(error.message, "handshake failed");
  assert.equal(error.closeError.code, "EAPPSERVERLIFECYCLE");
  assert.equal(error.lifecycle.settled, true);
  assert.equal(error.lifecycle.code, 7);
  assert.equal(error.lifecycle.cleanupOk, true);
});

test("probe accepts a final clean exit after an unsuccessful termination attempt", async () => {
  const peer = fakePeer(async (method) => {
    if (method === "initialize") return { userAgent: "codex-test" };
    if (method === "account/read") return { account: null, requiresOpenaiAuth: true };
    if (method === "thread/list") return { data: [], nextCursor: null };
    throw new Error(`unexpected method: ${method}`);
  });
  const open = async () => ({
    peer,
    close: async () => ({
      settlement: {
        code: 0,
        signal: null,
        error: null,
        unsettled: false,
        termination: {
          requested: true,
          graceExpired: false,
          error: { name: "Error", code: "ETERMINATIONFAILED", message: "taskkill raced with natural exit" },
        },
      },
      disposal: { cleanup: { attempted: true, ok: true, error: null } },
      stderr: { text: "", bytes: 0, truncated: false },
    }),
  });

  const result = await probeAppServerIdentity(
    { launchRecipe: { kind: "recipe" } },
    ["generated"],
    { open },
  );
  assert.equal(result.initialized, true);
  assert.equal(result.lifecycle.code, 0);
  assert.equal(result.lifecycle.cleanupOk, true);
});

test("probe accepts a real owned handle whose failed termination races with a clean final exit", async () => {
  const terminationError = Object.assign(new Error("taskkill raced with natural exit"), {
    code: "ETERMINATIONFAILED",
  });
  const { prepare, state } = scriptedStagedPrepare((message, send) => {
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "codex-test" } });
    } else if (message.method === "account/read") {
      send({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
    } else if (message.method === "thread/list") {
      send({ id: message.id, result: { data: [], nextCursor: null } });
    }
  }, { terminateError: terminationError });

  const result = await probeAppServerIdentity(
    { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
    ["generated"],
    { prepare, shutdownGraceMs: 5 },
  );

  assert.equal(result.initialized, true);
  assert.equal(result.lifecycle.code, 0);
  assert.equal(result.lifecycle.signal, null);
  assert.equal(result.lifecycle.cleanupOk, true);
  assert.deepEqual(result.lifecycle.terminationError, {
    name: "Error",
    code: "ETERMINATIONFAILED",
    message: "taskkill raced with natural exit",
  });
  assert.equal(state.terminateCalled, true);
  assert.equal(state.disposeCalled, true);
});

test("openAppServer launches only through the staged recipe and bounds stderr", async () => {
  const candidate = { path: "C:\\sensitive\\codex.cmd", launchRecipe: { kind: "private-staged-snapshot", token: "recipe-only" } };
  const { prepare, state } = scriptedStagedPrepare(() => {}, { stderrText: "abcdef" });
  const handle = await openAppServer(candidate, { prepare, maxStderrBytes: 4, shutdownGraceMs: 5 });

  assert.equal(state.prepareArgument, candidate.launchRecipe);
  assert.deepEqual(state.spawnArguments, ["app-server", "--listen", "stdio://"]);
  assert.equal("resource" in handle, false);
  assert.equal("stagePath" in handle, false);
  assert.equal(JSON.stringify(handle).includes("sensitive"), false);

  const closed = await handle.close();
  assert.deepEqual(closed.stderr, { text: "abcd", bytes: 6, truncated: true });
  assert.deepEqual(state.order, ["terminate", "settle", "dispose"]);
  assert.equal(state.disposeCalled, true);
  assert.deepEqual(await handle.close(), closed);
});

test("openAppServer accepts only the two fixed read-only App Server launch recipes", async () => {
  const candidate = { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } };
  const { prepare, state } = scriptedStagedPrepare(() => {});
  const desktopArguments = [
    "-c",
    "features.code_mode_host=true",
    "app-server",
    "--analytics-default-enabled",
  ];
  const handle = await openAppServer(candidate, { prepare, appServerArguments: desktopArguments, shutdownGraceMs: 5 });
  assert.deepEqual(state.spawnArguments, desktopArguments);
  await handle.close();

  let prepareCalls = 0;
  await assert.rejects(
    openAppServer(candidate, {
      prepare: async () => { prepareCalls += 1; },
      appServerArguments: ["app-server", "--dangerous-write-mode"],
    }),
    /fixed read-only launch recipe/u,
  );
  assert.equal(prepareCalls, 0);
});

test("openAppServer closes with stdin EOF before forcing process-tree termination", async () => {
  const { prepare, state } = scriptedStagedPrepare(() => {}, { settleOnStdinEnd: true });
  const handle = await openAppServer(
    { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
    { prepare, shutdownGraceMs: 5 },
  );

  const closed = await handle.close();
  assert.equal(closed.settlement.code, 0);
  assert.equal(state.terminateCalled, false);
  assert.deepEqual(state.order, ["stdinEnd", "settle", "dispose"]);
});

test("unsettled close schedules exactly one deferred dispose after eventual settlement", async () => {
  const { prepare, state } = delayedLifecyclePrepare({ settleDelayMs: 30 });
  const handle = await openAppServer(
    { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
    { prepare, shutdownGraceMs: 5 },
  );

  const firstError = await handle.close().catch((error) => error);
  assert.equal(firstError.code, "ECHILDUNSETTLED");
  assert.equal(firstError.lifecycle.settled, false);
  assert.deepEqual(firstError.lifecycle.cleanup, { attempted: false, deferred: true, retained: true, ok: false, error: null });
  assert.equal(typeof firstError.deferredCleanup?.then, "function");
  const secondError = await handle.close().catch((error) => error);
  assert.strictEqual(secondError, firstError);

  const deferred = await firstError.deferredCleanup;
  assert.equal(deferred.settlement.code, 0);
  assert.equal(deferred.disposal.cleanup.ok, true);
  assert.equal(state.terminateCount, 1);
  assert.equal(state.disposeCount, 1);
  assert.strictEqual(secondError.deferredCleanup, firstError.deferredCleanup);
});

test("permanently unsettled close retains staging with explicit deferred evidence", async () => {
  const { prepare, state } = delayedLifecyclePrepare();
  const handle = await openAppServer(
    { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
    { prepare, shutdownGraceMs: 5 },
  );

  const error = await handle.close().catch((value) => value);
  assert.equal(error.code, "ECHILDUNSETTLED");
  assert.equal(error.lifecycle.settled, false);
  assert.deepEqual(error.lifecycle.cleanup, { attempted: false, deferred: true, retained: true, ok: false, error: null });
  assert.deepEqual(await outcomeWithin(error.deferredCleanup, 20), { kind: "timeout" });
  assert.equal(state.terminateCount, 1);
  assert.equal(state.disposeCount, 0);
});

test("failed deferred disposal remains explicitly retained", async () => {
  const disposeError = Object.assign(new Error("deferred cleanup failed"), { code: "ECLEANUP" });
  const { prepare, state } = delayedLifecyclePrepare({ settleDelayMs: 30, disposeError });
  const handle = await openAppServer(
    { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
    { prepare, shutdownGraceMs: 5 },
  );

  const error = await handle.close().catch((value) => value);
  const deferred = await error.deferredCleanup;
  assert.equal(deferred.cleanup.ok, false);
  assert.equal(deferred.cleanup.retained, true);
  assert.deepEqual(deferred.cleanup.error, { name: "Error", code: "ECLEANUP", message: "deferred cleanup failed" });
  assert.equal(state.disposeCount, 1);
});

test("initialize failure terminates, settles, and disposes the owned staged child", async () => {
  const { prepare, state } = scriptedStagedPrepare((message, send) => {
    if (message.method === "initialize") send({ id: message.id, error: { code: -32603, message: "handshake denied" } });
  });

  const error = await probeAppServerIdentity(
    { launchRecipe: { kind: "private-staged-snapshot", token: "recipe" } },
    ["generated"],
    { prepare, shutdownGraceMs: 5 },
  ).catch((value) => value);
  assert.equal(error.message, "handshake denied");
  assert.deepEqual(error.rpc, { code: -32603, message: "handshake denied" });
  assert.deepEqual(state.order, ["terminate", "settle", "dispose"]);
  assert.equal(state.terminateCalled, true);
  assert.equal(state.disposeCalled, true);
});
