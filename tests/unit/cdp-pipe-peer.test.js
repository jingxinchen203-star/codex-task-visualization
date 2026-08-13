import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { CdpPipePeer } from "../../src/cdp/pipe-peer.js";

const turn = () => new Promise((resolve) => setImmediate(resolve));

function collectNulFrames(stream) {
  const frames = [];
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let index;
    while ((index = buffer.indexOf(0)) >= 0) {
      const frame = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      if (frame.length) frames.push(JSON.parse(frame.toString("utf8")));
    }
  });
  return frames;
}

function writeFrame(stream, message, splitAt = null) {
  const bytes = Buffer.concat([Buffer.from(JSON.stringify(message)), Buffer.from([0])]);
  if (splitAt === null) stream.write(bytes);
  else {
    stream.write(bytes.subarray(0, splitAt));
    stream.write(bytes.subarray(splitAt));
  }
}

test("CdpPipePeer uses fd-pipe NUL framing and routes partial and multiple responses", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent = collectNulFrames(output);
  const peer = new CdpPipePeer(input, output, { maxOutboundHistory: 2 });

  const version = peer.request("Browser.getVersion");
  const evaluation = peer.request("Runtime.evaluate", { expression: "1+1" }, { sessionId: "session-a" });
  await turn();
  assert.deepEqual(sent.map(({ method, sessionId }) => [method, sessionId ?? null]), [
    ["Browser.getVersion", null],
    ["Runtime.evaluate", "session-a"],
  ]);

  const first = Buffer.concat([
    Buffer.from(JSON.stringify({ id: 1, result: { product: "FakeCodex/1.0" } })),
    Buffer.from([0]),
    Buffer.from(JSON.stringify({ id: 2, result: { result: { value: 2 } } })),
    Buffer.from([0]),
  ]);
  input.write(first.subarray(0, 7));
  input.write(first.subarray(7));

  assert.deepEqual(await version, { product: "FakeCodex/1.0" });
  assert.deepEqual(await evaluation, { result: { value: 2 } });
  assert.equal(peer.pendingCount, 0);
  assert.equal(peer.outbound.length, 2);
});

test("CdpPipePeer preserves CDP RPC errors", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new CdpPipePeer(input, output);
  const request = peer.request("Target.attachToTarget", { targetId: "missing" });
  await turn();
  writeFrame(input, { id: 1, error: { code: -32000, message: "No target", data: "missing" } }, 4);

  const error = await request.catch((value) => value);
  assert.equal(error.message, "No target");
  assert.deepEqual(error.rpc, { code: -32000, message: "No target", data: "missing" });
});

test("CdpPipePeer fails closed on malformed and oversized frames", async () => {
  for (const [bytes, maxInboundFrameBytes] of [
    [Buffer.from("{broken\0"), 100],
    [Buffer.from(`${"x".repeat(17)}\0`), 16],
    [Buffer.from("x".repeat(17)), 16],
  ]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new CdpPipePeer(input, output, { maxInboundFrameBytes });
    const pending = peer.request("Browser.getVersion", {}, { timeoutMs: 100 });
    input.write(bytes);
    await assert.rejects(pending, (error) => error.code === "EPROTOCOL");
    assert.equal(peer.pendingCount, 0);
  }
});

test("CdpPipePeer settles timeout, stream races, child close, and repeated close once", async () => {
  {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new CdpPipePeer(input, output);
    await assert.rejects(
      peer.request("Browser.getVersion", {}, { timeoutMs: 10 }),
      (error) => error.code === "ETIMEDOUT",
    );
    assert.equal(peer.pendingCount, 0);
  }

  {
    const input = new PassThrough();
    let callback;
    const output = new Writable({
      write(_chunk, _encoding, done) { callback = done; },
    });
    const peer = new CdpPipePeer(input, output);
    let rejectionCount = 0;
    const pending = peer.request("Browser.getVersion").catch((error) => {
      rejectionCount += 1;
      return error;
    });
    await turn();
    output.emit("error", new Error("pipe write failed"));
    callback(new Error("late callback failure"));
    input.emit("close");
    input.emit("close");
    const error = await pending;
    assert.match(error.message, /pipe write failed/);
    await turn();
    assert.equal(rejectionCount, 1);
    assert.equal(peer.pendingCount, 0);
    assert.equal(peer.activeWriteCount, 0);
  }

  {
    const input = new PassThrough();
    const output = new PassThrough();
    const child = new PassThrough();
    const peer = new CdpPipePeer(input, output, { child });
    const pending = peer.request("Browser.getVersion");
    child.emit("close", 9, null);
    child.emit("close", 9, null);
    await assert.rejects(pending, /child closed/i);
    assert.equal(peer.pendingCount, 0);
  }
});

test("CdpPipePeer bounds outbound history without losing request IDs", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new CdpPipePeer(input, output, { maxOutboundHistory: 2 });
  for (let id = 1; id <= 3; id += 1) {
    const pending = peer.request(`Test.${id}`);
    await turn();
    writeFrame(input, { id, result: { id } });
    await pending;
  }
  assert.deepEqual(peer.outbound.map(({ id }) => id), [2, 3]);
});

test("a request timeout settles a write whose callback never arrives", async () => {
  const input = new PassThrough();
  const output = new Writable({ write() {} });
  const peer = new CdpPipePeer(input, output);
  const pending = peer.request("Browser.getVersion", {}, { timeoutMs: 10 });

  await assert.rejects(pending, (error) => error.code === "ETIMEDOUT");
  assert.equal(peer.pendingCount, 0);
  assert.equal(peer.activeWriteCount, 0);
  await assert.rejects(peer.request("Target.getTargets"), (error) => error.code === "ETIMEDOUT");
});
