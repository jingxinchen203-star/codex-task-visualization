import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { probeDirectPipe } from "../../src/cdp/pipe-probe.js";

const fakeChild = fileURLToPath(new URL("../../scripts/probes/fake-cdp-pipe-child.mjs", import.meta.url));

test("probeDirectPipe mounts once in every fake Codex app renderer over the debugging pipe", async () => {
  const result = await probeDirectPipe(process.execPath, [fakeChild], {
    targetPollIntervalMs: 1,
    targetPollAttempts: 3,
    requestTimeoutMs: 1_000,
    childCloseTimeoutMs: 1_000,
  });

  assert.equal(result.browserVersion, "FakeCodex/1.0");
  assert.equal(result.mountResult, "PASS");
  assert.equal(result.fixture.host, "127.0.0.1");
  assert.equal(result.fixture.closed, true);
  assert.deepEqual(result.renderers.map(({ targetId }) => targetId), ["app-alpha", "app-beta"]);
  assert.deepEqual(result.renderers.map(({ count }) => count), [1, 1]);
  assert.equal(result.renderers.every(({ exceptionDetails }) => exceptionDetails.length === 0), true);
  assert.equal(result.child.closed, true);
  assert.equal(result.child.exitCode, 0);

  const methods = result.outbound.map(({ method }) => method);
  assert.deepEqual(methods, [
    "Browser.getVersion",
    "Target.getTargets",
    "Target.getTargets",
    "Target.getTargets",
    "Target.attachToTarget",
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Target.attachToTarget",
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Browser.close",
  ]);
  assert.equal(methods.includes(["Page", "setBypass", "CSP"].join(".")), false);
  assert.deepEqual(
    result.outbound.filter(({ method }) => method === "Target.attachToTarget").map(({ params }) => params),
    [
      { targetId: "app-alpha", flatten: true },
      { targetId: "app-beta", flatten: true },
    ],
  );
  for (const renderer of result.renderers) {
    assert.deepEqual(renderer.mounts.map(({ status, count }) => ({ status, count })), [
      { status: "loaded", count: 1 },
      { status: "loaded", count: 1 },
    ]);
    assert.equal(renderer.removed, 1);
  }
});

test("probeDirectPipe cannot deadlock on an owned child's diagnostic output", async () => {
  const result = await probeDirectPipe(process.execPath, [fakeChild, "--flood-stderr"], {
    targetPollIntervalMs: 1,
    targetPollAttempts: 3,
    requestTimeoutMs: 500,
    childCloseTimeoutMs: 500,
  });
  assert.equal(result.browserVersion, "FakeCodex/1.0");
  assert.equal(result.mountResult, "PASS");
  assert.deepEqual(result.child, { closed: true, exitCode: 0, signal: null, error: null });
  assert.equal(result.stderr.bytes, 4 * 1024 * 1024);
  assert.equal(result.stderr.truncated, true);
  assert.equal(Buffer.byteLength(result.stderr.text), 64 * 1024);
});

test("probeDirectPipe can mount a CSP-allowed blob fixture without a loopback content server", async () => {
  const result = await probeDirectPipe(process.execPath, [fakeChild], {
    fixtureMode: "blob",
    targetPollIntervalMs: 1,
    targetPollAttempts: 3,
    requestTimeoutMs: 1_000,
    childCloseTimeoutMs: 1_000,
  });
  assert.equal(result.mountResult, "PASS");
  assert.deepEqual(result.fixture, { kind: "blob", closed: true });
  const mountExpressions = result.outbound
    .filter(({ method, params }) => method === "Runtime.evaluate" && params.expression.includes("projectboard-phase0:mount"))
    .map(({ params }) => params.expression);
  assert.equal(mountExpressions.length, 4);
  assert.equal(mountExpressions.every((expression) => expression.includes("new Blob")), true);
  assert.equal(mountExpressions.some((expression) => expression.includes("http://127.0.0.1")), false);
});

test("probeDirectPipe rejects an unclean owned-child exit", async () => {
  const error = await probeDirectPipe(process.execPath, [fakeChild, "--close-code=7"], {
      targetPollIntervalMs: 1,
      targetPollAttempts: 3,
      requestTimeoutMs: 500,
      childCloseTimeoutMs: 500,
    }).catch((value) => value);
  assert.match(error.message, /owned CDP child exited with code 7/i);
  assert.deepEqual(error.stderr, { text: "", bytes: 0, truncated: false });
  assert.equal(error.probe.mountResult, "PASS");
  assert.equal(error.probe.rendererCount, 2);
  assert.equal(error.probe.fixture.closed, true);
  assert.equal(error.probe.outboundMethods.at(-1), "Browser.close");
});

test("target polling accumulates a later window and waits for a stable snapshot", async () => {
  const result = await probeDirectPipe(process.execPath, [fakeChild], {
    targetPollIntervalMs: 1,
    targetPollAttempts: 4,
    targetStableSnapshots: 2,
    requestTimeoutMs: 500,
    childCloseTimeoutMs: 500,
  });

  assert.deepEqual(result.renderers.map(({ targetId }) => targetId), ["app-alpha", "app-beta"]);
  assert.equal(result.outbound.filter(({ method }) => method === "Target.getTargets").length, 3);
  assert.equal(result.outbound.filter(({ method }) => method === "Target.attachToTarget").length, 2);
});

test("one target attempt returns its accumulated app pages without waiting again", async () => {
  const startedAt = Date.now();
  const result = await probeDirectPipe(process.execPath, [fakeChild], {
    targetPollIntervalMs: 1_000,
    targetPollAttempts: 1,
    targetStableSnapshots: 2,
    requestTimeoutMs: 500,
    childCloseTimeoutMs: 500,
  });

  assert.deepEqual(result.renderers.map(({ targetId }) => targetId), ["app-alpha"]);
  assert.equal(result.outbound.filter(({ method }) => method === "Target.getTargets").length, 1);
  assert.ok(Date.now() - startedAt < 750, "the exhausted attempt bound must not sleep for the poll interval");
});

test("clean transport close before Browser.close response is an expected owned-child race", async () => {
  const result = await probeDirectPipe(process.execPath, [fakeChild, "--close-without-response"], {
    targetPollIntervalMs: 1,
    targetPollAttempts: 4,
    requestTimeoutMs: 500,
    childCloseTimeoutMs: 500,
  });

  assert.equal(result.mountResult, "PASS");
  assert.deepEqual(result.child, { closed: true, exitCode: 0, signal: null, error: null });
});

test("unclean no-response close and a close RPC error remain failures", async () => {
  await assert.rejects(
    probeDirectPipe(process.execPath, [fakeChild, "--close-without-response", "--close-code=7"], {
      targetPollIntervalMs: 1,
      targetPollAttempts: 4,
      requestTimeoutMs: 500,
      childCloseTimeoutMs: 500,
    }),
    /code 7/i,
  );
  await assert.rejects(
    probeDirectPipe(process.execPath, [fakeChild, "--close-rpc-error"], {
      targetPollIntervalMs: 1,
      targetPollAttempts: 4,
      requestTimeoutMs: 500,
      childCloseTimeoutMs: 500,
    }),
    (error) => error.message === "close rejected" && error.rpc?.code === -32000,
  );
});

test("Browser.close timeout remains primary when fallback termination settles the child", async () => {
  const error = await probeDirectPipe(process.execPath, [fakeChild, "--ignore-close"], {
    targetPollIntervalMs: 1,
    targetPollAttempts: 4,
    requestTimeoutMs: 500,
    childCloseTimeoutMs: 50,
  }).catch((value) => value);

  assert.equal(error.code, "ETIMEDOUT");
  assert.match(error.message, /Browser\.close.*timed out/i);
  assert.deepEqual(error.cleanup.forcedTermination, {
    requested: true,
    signal: "SIGTERM",
    accepted: true,
    error: null,
  });
  assert.equal(error.cleanup.child.closed, true);
  assert.equal(error.cleanup.child.exitCode, null);
  assert.equal(error.cleanup.child.signal, "SIGTERM");
  assert.equal(error.cleanup.child.error, null);
});
