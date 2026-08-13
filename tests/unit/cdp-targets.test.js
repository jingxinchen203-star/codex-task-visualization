import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  buildFrameExpression,
  readEvaluationValue,
  selectCodexTargets,
} from "../../src/cdp/targets.js";

function receiptSnapshot(hex = "a", taskCount = 2) {
  return {
    snapshotId: hex.repeat(64),
    mode: "standalone-readonly",
    summary: { taskCount },
    projects: [],
  };
}

function messageTarget() {
  const listeners = new Set();
  return {
    addEventListener(name, listener) { if (name === "message") listeners.add(listener); },
    removeEventListener(name, listener) { if (name === "message") listeners.delete(listener); },
    dispatchMessage(event) { for (const listener of [...listeners]) listener(event); },
    listenerCount() { return listeners.size; },
  };
}

function messageCapableFrame(nodes, posted = []) {
  const attributes = new Map();
  const listeners = new Map();
  return {
    tagName: "IFRAME",
    id: "",
    src: "",
    style: {},
    contentWindow: {
      postMessage(message, targetOrigin) { posted.push({ message, targetOrigin }); },
    },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    dispatch(name) { listeners.get(name)?.(); },
    listenerCount() { return listeners.size; },
    remove() {
      for (const [id, node] of nodes) if (node === this) nodes.delete(id);
    },
    replaceWith(replacement) {
      for (const [id, node] of nodes) {
        if (node === this || node === replacement) nodes.delete(id);
      }
      nodes.set(replacement.id, replacement);
    },
  };
}

function manualTimers() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    setTimeout(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) { callbacks.delete(id); },
    firstCallback() { return callbacks.values().next().value; },
    fireAll() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    count() { return callbacks.size; },
  };
}

test("selectCodexTargets returns every app page in deterministic identity order", () => {
  const selected = selectCodexTargets([
    { targetId: "z-window", type: "page", url: "app://codex/z" },
    { targetId: "foreign", type: "page", url: "https://example.test/" },
    { targetId: "worker", type: "service_worker", url: "app://codex/worker" },
    { id: "a-window", type: "page", url: "app://codex/a" },
    { targetId: "b-window", id: "wrong-fallback", type: "page", url: "APP://codex/b" },
  ]);

  assert.deepEqual(selected.map(({ targetId }) => targetId), ["a-window", "b-window", "z-window"]);
  assert.equal(selected[1].id, "wrong-fallback", "a real targetId must not be confused with the fallback id field");
});

test("selectCodexTargets rejects missing or unusable app pages", () => {
  assert.throws(() => selectCodexTargets([]), /no Codex app page targets/i);
  assert.throws(
    () => selectCodexTargets([{ type: "page", url: "app://codex/window" }]),
    /targetId or id/i,
  );
});

test("frame expressions are idempotent actions with JSON-encoded input", () => {
  const adversarialUrl = "http://127.0.0.1:1234/'\"</script>${globalThis.pwned=true}";
  const mount = buildFrameExpression("mount", { url: adversarialUrl, timeoutMs: 321 });
  const count = buildFrameExpression("count");
  const remove = buildFrameExpression("remove");

  assert.match(mount, /projectboard-phase0:mount/);
  assert.match(mount, /getElementById/);
  assert.match(mount, /createElement/);
  assert.ok(mount.includes(JSON.stringify(adversarialUrl)));
  assert.equal(mount.includes(["Page", "setBypass", "CSP"].join(".")), false);
  assert.match(count, /projectboard-phase0:count/);
  assert.match(remove, /projectboard-phase0:remove/);
  assert.throws(
    () => buildFrameExpression("mount", { url: adversarialUrl, layout: "overlay" }),
    /layout must be probe or sidebar/u,
  );
});

test("sidebar entry overlays the Codex main workspace without squeezing the app root", () => {
  const mount = buildFrameExpression("mount", {
    html: "<!doctype html><title>Board</title>",
    layout: "sidebar",
  });
  const remove = buildFrameExpression("remove");
  assert.match(mount, /projectboard-phase1-toggle/u);
  assert.match(mount, /aria-expanded/u);
  assert.match(mount, /querySelector\("main"\)/u);
  assert.match(mount, /getBoundingClientRect/u);
  assert.equal(mount.includes("root.style.width"), false);
  assert.equal(mount.includes("clamp(420px, 44vw, 760px)"), false);
  assert.equal(remove.includes("data-projectboard-root-width"), false);
  assert.match(remove, /projectboard-phase1-toggle/u);
});

test("sidebar mount waits for an exact renderer-ready receipt after load", async () => {
  const snapshot = receiptSnapshot("a", 2);
  const nodes = new Map();
  const parent = messageTarget();
  const document = {
    body: { appendChild(frame) { nodes.set(frame.id, frame); } },
    documentElement: null,
    getElementById(id) { return nodes.get(id) ?? null; },
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector === "#projectboard-phase0-frame"
        ? [...nodes.values()].filter(({ id }) => id === "projectboard-phase0-frame")
        : [];
    },
    createElement(tagName) {
      if (tagName === "iframe") return messageCapableFrame(nodes);
      const attributes = new Map();
      return {
        tagName: tagName.toUpperCase(), id: "", style: {},
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
      };
    },
  };
  const context = {
    Blob: class Blob {},
    URL: { createObjectURL: () => "blob:receipt-board" },
    document,
    addEventListener: parent.addEventListener,
    removeEventListener: parent.removeEventListener,
    setTimeout: () => 1,
    clearTimeout() {},
  };
  context.window = { dispatchMessage: parent.dispatchMessage };
  const expression = buildFrameExpression("mount", {
    html: "<!doctype html><title>Board</title>",
    layout: "sidebar",
    snapshot,
    timeoutMs: 50,
  });
  const pending = runInNewContext(expression, context);
  await Promise.resolve();
  await Promise.resolve();
  const frame = nodes.get("projectboard-phase0-frame");
  let settled = false;
  pending.then(() => { settled = true; });

  frame.dispatch("load");
  await Promise.resolve();
  assert.equal(settled, false, "load alone must not acknowledge rendered task content");

  context.window.dispatchMessage({
    source: {},
    data: {
      type: "projectboard-readonly-ready",
      snapshotId: snapshot.snapshotId,
      sourceTaskCount: 2,
      renderedTaskCount: 2,
    },
  });
  context.window.dispatchMessage({
    source: frame.contentWindow,
    data: {
      type: "projectboard-readonly-ready",
      snapshotId: "b".repeat(64),
      sourceTaskCount: 2,
      renderedTaskCount: 2,
    },
  });
  context.window.dispatchMessage({
    source: frame.contentWindow,
    data: {
      type: "projectboard-readonly-ready",
      snapshotId: snapshot.snapshotId,
      sourceTaskCount: 2,
      renderedTaskCount: 1,
    },
  });
  await Promise.resolve();
  assert.equal(settled, false, "wrong source, identity, or counts must not acknowledge the mount");

  context.window.dispatchMessage({
    source: frame.contentWindow,
    data: {
      type: "projectboard-readonly-ready",
      snapshotId: snapshot.snapshotId,
      sourceTaskCount: snapshot.summary.taskCount,
      renderedTaskCount: snapshot.summary.taskCount,
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    status: "loaded",
    count: 1,
    snapshotId: snapshot.snapshotId,
    renderedTaskCount: snapshot.summary.taskCount,
  });
  assert.equal(parent.listenerCount(), 0);
  assert.equal(frame.listenerCount(), 0);
});

test("sidebar acknowledges a scriptless static board when inherited CSP blocks blob scripts", async () => {
  const initial = receiptSnapshot("d", 2);
  const next = receiptSnapshot("e", 3);
  const rejectedSnapshot = receiptSnapshot("f", 4);
  const staticHtml = (snapshot) => `<!doctype html><html data-projectboard-static="true"
    data-projectboard-mode="standalone-readonly"
    data-projectboard-snapshot-id="${snapshot.snapshotId}"
    data-projectboard-rendered-task-count="${snapshot.summary.taskCount}"><body></body></html>`;
  const staticDocument = (snapshot) => {
    const rootAttributes = new Map([
      ["data-projectboard-static", "true"],
      ["data-projectboard-mode", "standalone-readonly"],
      ["data-projectboard-snapshot-id", snapshot.snapshotId],
      ["data-projectboard-rendered-task-count", String(snapshot.summary.taskCount)],
    ]);
    const tasks = Array.from({ length: snapshot.summary.taskCount }, (_, index) => ({
      getAttribute: (name) => name === "data-projectboard-task-id" ? `task-${index}` : null,
    }));
    const lanes = ["inbox", "planned", "running", "review", "done"].map((id) => ({
      getAttribute: (name) => name === "data-projectboard-lane" ? id : null,
    }));
    return {
      documentElement: { getAttribute: (name) => rootAttributes.get(name) ?? null },
      querySelectorAll(selector) {
        if (selector === "[data-projectboard-task-id]") return tasks;
        if (selector === "[data-projectboard-lane]") return lanes;
        return [];
      },
    };
  };
  const nodes = new Map();
  const timers = manualTimers();
  let blobHtml = null;
  let iframeCreations = 0;
  const document = {
    body: { appendChild(frame) { nodes.set(frame.id, frame); } },
    documentElement: null,
    getElementById(id) { return nodes.get(id) ?? null; },
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector === "#projectboard-phase0-frame"
        ? [...nodes.values()].filter(({ id }) => id === "projectboard-phase0-frame")
        : [];
    },
    createElement(tagName) {
      if (tagName === "iframe") {
        const frame = messageCapableFrame(nodes);
        frame.contentDocument = staticDocument(iframeCreations++ === 0 ? initial : next);
        return frame;
      }
      return {
        tagName: tagName.toUpperCase(), id: "", style: {},
        setAttribute() {}, getAttribute() { return null; },
      };
    },
  };
  const context = {
    Blob: class Blob { constructor(parts) { blobHtml = parts.join(""); } },
    URL: { createObjectURL: () => "blob:csp-compatible-board", revokeObjectURL() {} },
    document,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };

  const mounted = runInNewContext(buildFrameExpression("mount", {
    html: staticHtml(initial),
    layout: "sidebar",
    snapshot: initial,
    timeoutMs: 50,
  }), context);
  await Promise.resolve();
  await Promise.resolve();
  const frame = nodes.get("projectboard-phase0-frame");
  frame.dispatch("load");
  await Promise.resolve();
  timers.fireAll();

  assert.deepEqual(JSON.parse(JSON.stringify(await mounted)), {
    status: "loaded",
    count: 1,
    snapshotId: initial.snapshotId,
    renderedTaskCount: initial.summary.taskCount,
  });
  assert.equal(frame.getAttribute("sandbox"), "allow-same-origin");
  assert.doesNotMatch(blobHtml, /<script/iu, "the child document must contain no executable script");

  const refreshed = runInNewContext(buildFrameExpression("update", {
    html: staticHtml(next),
    snapshot: next,
    updateId: "static-refresh",
    timeoutMs: 50,
  }), context);
  await Promise.resolve();
  await Promise.resolve();
  const candidate = [...nodes.values()].find((node) => node !== frame && node.tagName === "IFRAME");
  assert.ok(candidate, "a static refresh must stage a separate candidate iframe");
  assert.equal(nodes.get("projectboard-phase0-frame"), frame, "the last good board must remain mounted while the candidate loads");
  candidate.dispatch("load");
  assert.deepEqual(JSON.parse(JSON.stringify(await refreshed)), {
    status: "updated",
    updated: true,
  });
  const current = nodes.get("projectboard-phase0-frame");
  assert.notEqual(current, frame, "the validated candidate must atomically replace the last good frame");
  assert.equal(current.getAttribute("data-projectboard-snapshot-id"), next.snapshotId);
  assert.equal(current.getAttribute("data-projectboard-rendered-task-count"), "3");

  const cached = runInNewContext(buildFrameExpression("update", {
    html: staticHtml(next),
    snapshot: next,
    updateId: "unchanged-static-refresh",
    timeoutMs: 50,
  }), context);
  await Promise.resolve();
  await Promise.resolve();
  const unnecessaryCandidate = [...nodes.values()].find((node) => node !== current && node.tagName === "IFRAME");
  assert.equal(unnecessaryCandidate, undefined, "an unchanged static identity must not replace the renderer document");
  assert.deepEqual(JSON.parse(JSON.stringify(await cached)), { status: "updated", updated: true });

  const rejected = runInNewContext(buildFrameExpression("update", {
    html: staticHtml(rejectedSnapshot),
    snapshot: rejectedSnapshot,
    updateId: "rejected-static-refresh",
    timeoutMs: 50,
  }), context);
  await Promise.resolve();
  await Promise.resolve();
  const invalidCandidate = [...nodes.values()].find((node) => node !== current && node.tagName === "IFRAME");
  invalidCandidate.dispatch("load");
  const rejectedResult = JSON.parse(JSON.stringify(await rejected));
  assert.equal(rejectedResult.status, "error");
  assert.equal(rejectedResult.updated, false);
  assert.equal(nodes.get("projectboard-phase0-frame"), current, "an invalid candidate must preserve the last good board");
});

test("frame update posts one validated snapshot and waits for its exact applied receipt", async () => {
  const snapshot = receiptSnapshot("b", 3);
  const nodes = new Map();
  const posted = [];
  const frame = messageCapableFrame(nodes, posted);
  frame.id = "projectboard-phase0-frame";
  nodes.set(frame.id, frame);
  const parent = messageTarget();
  const timers = manualTimers();
  const context = {
    document: { getElementById: (id) => nodes.get(id) ?? null },
    addEventListener: parent.addEventListener,
    removeEventListener: parent.removeEventListener,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  context.window = { dispatchMessage: parent.dispatchMessage };
  const update = buildFrameExpression("update", { snapshot, updateId: "update-1", timeoutMs: 50 });
  assert.match(update, /projectboard-phase1:update/u);
  assert.match(update, /projectboard-readonly-snapshot/u);
  assert.ok(update.includes(JSON.stringify(snapshot)));
  const pending = runInNewContext(update, context);
  const timeoutCallback = timers.firstCallback();
  assert.equal(typeof pending?.then, "function", "update must wait for a renderer-applied receipt");
  let settled = false;
  pending.then(() => { settled = true; });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{
    message: { type: "projectboard-readonly-snapshot", updateId: "update-1", snapshot },
    targetOrigin: "*",
  }]);
  await Promise.resolve();
  assert.equal(settled, false, "postMessage alone must not acknowledge an update");

  context.window.dispatchMessage({
    source: frame.contentWindow,
    data: {
      type: "projectboard-readonly-applied",
      updateId: "wrong-update",
      snapshotId: snapshot.snapshotId,
      sourceTaskCount: 3,
      renderedTaskCount: 3,
    },
  });
  await Promise.resolve();
  assert.equal(settled, false);
  context.window.dispatchMessage({
    source: frame.contentWindow,
    data: {
      type: "projectboard-readonly-applied",
      updateId: "update-1",
      snapshotId: snapshot.snapshotId,
      sourceTaskCount: snapshot.summary.taskCount,
      renderedTaskCount: snapshot.summary.taskCount,
    },
  });
  const result = await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: "updated",
    updated: true,
  });
  assert.equal(parent.listenerCount(), 0);
  assert.equal(timers.count(), 0);
  timeoutCallback();
  await Promise.resolve();
  assert.deepEqual(
    JSON.parse(JSON.stringify(await pending)),
    JSON.parse(JSON.stringify(result)),
    "a cleared timeout must not win the receipt race",
  );

  assert.throws(() => buildFrameExpression("update"), /valid receipt identity/u);
  assert.throws(
    () => buildFrameExpression("update", { snapshot: { ...snapshot, snapshotId: "short" }, updateId: "update-1" }),
    /valid receipt identity/u,
  );
});

test("an applied update replaces the mount receipt cache without accepting the older snapshot", async () => {
  const initial = receiptSnapshot("4", 1);
  const next = receiptSnapshot("5", 2);
  const nodes = new Map();
  const parent = messageTarget();
  const document = {
    body: { appendChild(node) { nodes.set(node.id, node); } },
    documentElement: null,
    getElementById(id) { return nodes.get(id) ?? null; },
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector === "#projectboard-phase0-frame"
        ? [...nodes.values()].filter(({ id }) => id === "projectboard-phase0-frame")
        : [];
    },
    createElement(tagName) {
      if (tagName === "iframe") return messageCapableFrame(nodes);
      const attributes = new Map();
      return {
        tagName: tagName.toUpperCase(), id: "", style: {},
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
      };
    },
  };
  const context = {
    Blob: class Blob {},
    URL: { createObjectURL: () => "blob:cached-board" },
    document,
    addEventListener: parent.addEventListener,
    removeEventListener: parent.removeEventListener,
    setTimeout: () => 1,
    clearTimeout() {},
  };
  context.window = { dispatchMessage: parent.dispatchMessage };

  const mount = runInNewContext(buildFrameExpression("mount", {
    html: "<!doctype html><title>Initial</title>",
    layout: "sidebar",
    snapshot: initial,
    timeoutMs: 50,
  }), context);
  await Promise.resolve();
  await Promise.resolve();
  const frame = nodes.get("projectboard-phase0-frame");
  context.window.dispatchMessage({
    source: frame.contentWindow,
    data: {
      type: "projectboard-readonly-ready",
      snapshotId: initial.snapshotId,
      sourceTaskCount: 1,
      renderedTaskCount: 1,
    },
  });
  await mount;

  const update = runInNewContext(buildFrameExpression("update", {
    snapshot: next,
    updateId: "cache-update",
    timeoutMs: 50,
  }), context);
  context.window.dispatchMessage({
    source: frame.contentWindow,
    data: {
      type: "projectboard-readonly-applied",
      updateId: "cache-update",
      snapshotId: next.snapshotId,
      sourceTaskCount: 2,
      renderedTaskCount: 2,
    },
  });
  await update;
  assert.equal(frame.getAttribute("data-projectboard-loaded"), "true");
  assert.equal(frame.getAttribute("data-projectboard-snapshot-id"), next.snapshotId);
  assert.equal(frame.getAttribute("data-projectboard-rendered-task-count"), "2");

  const cachedNext = await runInNewContext(buildFrameExpression("mount", {
    html: "<!doctype html><title>Next</title>",
    layout: "sidebar",
    snapshot: next,
    timeoutMs: 50,
  }), context);
  assert.equal(cachedNext.snapshotId, next.snapshotId);

  const olderMount = runInNewContext(buildFrameExpression("mount", {
    html: "<!doctype html><title>Initial</title>",
    layout: "sidebar",
    snapshot: initial,
    timeoutMs: 50,
  }), context);
  let olderSettled = false;
  olderMount.then(() => { olderSettled = true; });
  await Promise.resolve();
  assert.equal(olderSettled, false, "the pre-update identity must not be accepted from cache");
  context.window.dispatchMessage({
    source: frame.contentWindow,
    data: {
      type: "projectboard-readonly-ready",
      snapshotId: initial.snapshotId,
      sourceTaskCount: 1,
      renderedTaskCount: 1,
    },
  });
  await olderMount;
});

test("mount and update timeouts remove every listener and ignore late events", async () => {
  const snapshot = receiptSnapshot("6", 1);
  const nodes = new Map();
  const parent = messageTarget();
  const timers = manualTimers();
  const document = {
    body: { appendChild(node) { nodes.set(node.id, node); } },
    documentElement: null,
    getElementById(id) { return nodes.get(id) ?? null; },
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector === "#projectboard-phase0-frame"
        ? [...nodes.values()].filter(({ id }) => id === "projectboard-phase0-frame")
        : [];
    },
    createElement(tagName) {
      if (tagName === "iframe") return messageCapableFrame(nodes);
      const attributes = new Map();
      return {
        tagName: tagName.toUpperCase(), id: "", style: {},
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
      };
    },
  };
  const context = {
    Blob: class Blob {},
    URL: { createObjectURL: () => "blob:timeout-board" },
    document,
    addEventListener: parent.addEventListener,
    removeEventListener: parent.removeEventListener,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  context.window = { dispatchMessage: parent.dispatchMessage };
  const mount = runInNewContext(buildFrameExpression("mount", {
    html: "<!doctype html><title>Timeout</title>",
    layout: "sidebar",
    snapshot,
    timeoutMs: 50,
  }), context);
  await Promise.resolve();
  await Promise.resolve();
  const frame = nodes.get("projectboard-phase0-frame");
  timers.fireAll();
  assert.equal((await mount).status, "timeout");
  assert.equal(parent.listenerCount(), 0);
  assert.equal(frame.listenerCount(), 0);
  assert.equal(timers.count(), 0);
  frame.dispatch("load");
  frame.dispatch("error");
  context.window.dispatchMessage({ source: frame.contentWindow, data: { type: "projectboard-readonly-ready" } });

  const update = runInNewContext(buildFrameExpression("update", {
    snapshot,
    updateId: "timeout-update",
    timeoutMs: 50,
  }), context);
  timers.fireAll();
  assert.deepEqual(JSON.parse(JSON.stringify(await update)), {
    status: "timeout",
    updated: false,
    error: "sidebar update acknowledgement timed out",
  });
  assert.equal(parent.listenerCount(), 0);
  assert.equal(frame.listenerCount(), 0);
  assert.equal(timers.count(), 0);
  context.window.dispatchMessage({ source: frame.contentWindow, data: { type: "projectboard-readonly-applied" } });
});

test("a synchronous update post failure settles deterministically and cleans its timer and listener", async () => {
  const snapshot = receiptSnapshot("7", 1);
  const nodes = new Map();
  const frame = messageCapableFrame(nodes);
  frame.id = "projectboard-phase0-frame";
  frame.contentWindow.postMessage = () => { throw new Error("detached window"); };
  nodes.set(frame.id, frame);
  const parent = messageTarget();
  const timers = manualTimers();
  const result = await runInNewContext(buildFrameExpression("update", {
    snapshot,
    updateId: "throwing-update",
    timeoutMs: 50,
  }), {
    document: { getElementById: (id) => nodes.get(id) ?? null },
    addEventListener: parent.addEventListener,
    removeEventListener: parent.removeEventListener,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  }).then(
    (value) => value,
    (error) => ({ rejected: error.message }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: "error",
    updated: false,
    error: "sidebar update postMessage failed",
  });
  assert.equal(parent.listenerCount(), 0);
  assert.equal(timers.count(), 0);
});

test("stale action posts only the last-good snapshot identity without removing the frame", () => {
  const snapshot = receiptSnapshot("c", 1);
  const nodes = new Map();
  const posted = [];
  const frame = messageCapableFrame(nodes, posted);
  frame.id = "projectboard-phase0-frame";
  nodes.set(frame.id, frame);
  let expression;
  assert.doesNotThrow(() => { expression = buildFrameExpression("stale", { snapshot }); });
  const result = runInNewContext(expression, {
    document: { getElementById: (id) => nodes.get(id) ?? null },
  });
  assert.deepEqual({ status: result.status, posted: result.posted }, { status: "stale", posted: true });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{
    message: { type: "projectboard-readonly-stale", snapshotId: snapshot.snapshotId },
    targetOrigin: "*",
  }]);
  assert.equal(nodes.get(frame.id), frame);
  assert.equal(expression.includes(JSON.stringify(snapshot.projects)), false, "stale messages must not carry task content");
});

test("stale action marks only the matching scriptless static board", () => {
  const snapshot = receiptSnapshot("9", 1);
  const other = receiptSnapshot("8", 1);
  const nodes = new Map();
  const posted = [];
  const frame = messageCapableFrame(nodes, posted);
  const rootAttributes = new Map([
    ["data-projectboard-static", "true"],
    ["data-projectboard-snapshot-id", snapshot.snapshotId],
  ]);
  const status = { textContent: "快照正常" };
  frame.id = "projectboard-phase0-frame";
  frame.contentDocument = {
    documentElement: {
      getAttribute: (name) => rootAttributes.get(name) ?? null,
      setAttribute: (name, value) => rootAttributes.set(name, value),
    },
    querySelector: (selector) => selector === "#sync-status" ? status : null,
  };
  nodes.set(frame.id, frame);
  const context = { document: { getElementById: (id) => nodes.get(id) ?? null } };

  const ignored = runInNewContext(buildFrameExpression("stale", { snapshot: other }), context);
  assert.deepEqual(JSON.parse(JSON.stringify(ignored)), { status: "stale", posted: false });
  assert.equal(status.textContent, "快照正常");

  const marked = runInNewContext(buildFrameExpression("stale", { snapshot }), context);
  assert.deepEqual(JSON.parse(JSON.stringify(marked)), { status: "stale", posted: true });
  assert.equal(rootAttributes.get("data-projectboard-stale"), "true");
  assert.match(status.textContent, /数据已过期/u);
  assert.deepEqual(posted, []);
});

test("take-move consumes one snapshot-bound canonical request from a scriptless board", () => {
  const snapshot = receiptSnapshot("7", 1);
  const attributes = new Map([
    ["data-projectboard-thread-id", "thread/one"],
    ["data-projectboard-current-lane", "inbox"],
  ]);
  const request = {
    checked: true,
    getAttribute(name) {
      if (name === "data-projectboard-move-thread") return "thread/one";
      if (name === "data-projectboard-move-lane") return "planned";
      return null;
    },
  };
  const frame = {
    tagName: "IFRAME",
    contentWindow: {
      location: { hash: "" },
      history: {
        replaceState() {},
      },
    },
    contentDocument: {
      documentElement: {
        getAttribute(name) {
          if (name === "data-projectboard-static") return "true";
          if (name === "data-projectboard-snapshot-id") return snapshot.snapshotId;
          return null;
        },
      },
      querySelectorAll(selector) {
        if (selector === "[data-projectboard-thread-id]") {
          return [{ getAttribute: (name) => attributes.get(name) ?? null }];
        }
        if (selector === "[data-projectboard-move-thread][data-projectboard-move-lane]:checked") return [request];
        return [];
      },
    },
  };
  const context = {
    document: { getElementById: (id) => id === "projectboard-phase0-frame" ? frame : null },
  };

  const moved = runInNewContext(buildFrameExpression("take-move", { snapshot }), context);
  assert.deepEqual(JSON.parse(JSON.stringify(moved)), {
    status: "move",
    snapshotId: snapshot.snapshotId,
    threadId: "thread/one",
    laneId: "planned",
    currentLaneId: "inbox",
  });
  assert.equal(request.checked, false, "a handled request must be consumed exactly once");

  request.checked = true;
  request.getAttribute = (name) => name === "data-projectboard-move-thread" ? "thread/one" : "not-a-lane";
  const invalid = runInNewContext(buildFrameExpression("take-move", { snapshot }), context);
  assert.deepEqual(JSON.parse(JSON.stringify(invalid)), { status: "invalid" });
  assert.equal(request.checked, false);
});

test("take-move converts a safe card fragment click into one host-open request", () => {
  const snapshot = receiptSnapshot("5", 1);
  const location = {
    hash: "#projectboard-open/thread%2Fclicked",
    href: "blob:codex-board#projectboard-open/thread%2Fclicked",
  };
  const dropboxes = ["inbox", "planned", "running", "review", "done"].map((laneId) => ({
    value: "",
    getAttribute: (name) => name === "data-projectboard-drop-lane" ? laneId : null,
  }));
  const frame = {
    tagName: "IFRAME",
    contentWindow: {
      location,
      history: { replaceState() { location.hash = ""; } },
    },
    contentDocument: {
      documentElement: {
        getAttribute(name) {
          if (name === "data-projectboard-static") return "true";
          if (name === "data-projectboard-snapshot-id") return snapshot.snapshotId;
          return null;
        },
      },
      querySelectorAll(selector) {
        if (selector === "[data-projectboard-thread-id]") {
          return [{ getAttribute(name) {
            if (name === "data-projectboard-thread-id") return "thread/clicked";
            if (name === "data-projectboard-current-lane") return "inbox";
            return null;
          } }];
        }
        return selector === "[data-projectboard-drop-lane]" ? dropboxes : [];
      },
    },
  };

  const result = runInNewContext(buildFrameExpression("take-move", { snapshot }), {
    document: { getElementById: () => frame },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: "open",
    snapshotId: snapshot.snapshotId,
    threadId: "thread/clicked",
  });
  assert.equal(location.hash, "");
});

test("blob frame expressions encode local HTML, require one source, and revoke their URL", async () => {
  const html = "<!doctype html><main>'\"</script>${globalThis.pwned=true}</main>";
  const mount = buildFrameExpression("mount", { html, timeoutMs: 50 });
  const remove = buildFrameExpression("remove");
  assert.ok(mount.includes(JSON.stringify(html)));
  assert.match(mount, /new Blob/);
  assert.match(mount, /createObjectURL/);
  assert.match(remove, /revokeObjectURL/);
  assert.throws(() => buildFrameExpression("mount", { timeoutMs: 50 }), /exactly one/iu);
  assert.throws(
    () => buildFrameExpression("mount", { url: "http://127.0.0.1/", html, timeoutMs: 50 }),
    /exactly one/iu,
  );

  const nodes = new Map();
  const revoked = [];
  const document = {
    body: {
      appendChild(frame) {
        nodes.set(frame.id, frame);
        frame.dispatch("load");
      },
    },
    documentElement: null,
    getElementById(id) { return nodes.get(id) ?? null; },
    querySelectorAll(selector) { return selector === "#projectboard-phase0-frame" ? [...nodes.values()] : []; },
    createElement(tagName) {
      const attributes = new Map();
      const listeners = new Map();
      return {
        tagName: tagName.toUpperCase(),
        id: "",
        src: "",
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        addEventListener(name, listener) { listeners.set(name, listener); },
        removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
        dispatch(name) { listeners.get(name)?.(); },
        remove() { nodes.delete(this.id); },
      };
    },
  };
  const context = {
    Blob: class Blob { constructor(parts, options) { this.parts = parts; this.options = options; } },
    URL: {
      createObjectURL(blob) {
        assert.deepEqual(Array.from(blob.parts), [html]);
        assert.equal(blob.options.type, "text/html;charset=utf-8");
        return "blob:projectboard-fixture";
      },
      revokeObjectURL(value) { revoked.push(value); },
    },
    document,
    setTimeout(callback) { queueMicrotask(callback); return 1; },
    clearTimeout() {},
    queueMicrotask,
  };
  assert.equal((await runInNewContext(mount, context)).status, "loaded");
  assert.equal((await runInNewContext(mount, context)).status, "loaded");
  assert.equal(nodes.size, 1);
  const removed = runInNewContext(remove, context);
  assert.deepEqual({ removed: removed.removed, revoked: removed.revoked }, { removed: 1, revoked: 1 });
  assert.deepEqual(revoked, ["blob:projectboard-fixture"]);
});

test("readEvaluationValue preserves exceptions and unwraps return-by-value results", () => {
  assert.deepEqual(
    readEvaluationValue({ result: { type: "object", value: { status: "loaded", count: 1 } } }),
    { value: { status: "loaded", count: 1 }, exceptionDetails: null },
  );
  const exceptionDetails = { text: "Uncaught", lineNumber: 4 };
  assert.deepEqual(
    readEvaluationValue({ result: { type: "undefined" }, exceptionDetails }),
    { value: undefined, exceptionDetails },
  );
});

test("mount expression catches an immediate load and remains idempotent when executed twice", async () => {
  const nodes = new Map();
  const document = {
    body: {
      appendChild(frame) {
        nodes.set(frame.id, frame);
        frame.dispatch("load");
      },
    },
    documentElement: null,
    getElementById(id) { return nodes.get(id) ?? null; },
    querySelectorAll(selector) { return selector === "#projectboard-phase0-frame" ? [...nodes.values()] : []; },
    createElement(tagName) {
      const attributes = new Map();
      const listeners = new Map();
      return {
        tagName: tagName.toUpperCase(),
        id: "",
        src: "",
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        addEventListener(name, listener) { listeners.set(name, listener); },
        removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
        dispatch(name) { listeners.get(name)?.(); },
        remove() { nodes.delete(this.id); },
      };
    },
  };
  const context = {
    document,
    setTimeout(callback) { queueMicrotask(callback); return 1; },
    clearTimeout() {},
    queueMicrotask,
  };
  const expression = buildFrameExpression("mount", { url: "http://127.0.0.1:1234/projectboard.html", timeoutMs: 50 });
  const first = await runInNewContext(expression, context);
  const second = await runInNewContext(expression, context);

  assert.equal(first.status, "loaded");
  assert.equal(second.status, "loaded");
  assert.equal(nodes.size, 1);
});

test("sidebar mount waits until a newly announced renderer has a DOM host", async () => {
  const nodes = new Map();
  const document = {
    body: null,
    documentElement: null,
    getElementById(id) { return nodes.get(id) ?? null; },
    querySelector(selector) {
      if (selector === "main") return null;
      return null;
    },
    querySelectorAll(selector) { return selector === "#projectboard-phase0-frame" ? [...nodes.values()].filter(({ id }) => id === "projectboard-phase0-frame") : []; },
    createElement(tagName) {
      const attributes = new Map();
      const listeners = new Map();
      return {
        tagName: tagName.toUpperCase(),
        id: "",
        src: "",
        style: {},
        hidden: false,
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        addEventListener(name, listener) { listeners.set(name, listener); },
        removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
        dispatch(name) { listeners.get(name)?.(); },
        remove() { nodes.delete(this.id); },
      };
    },
  };
  let timerCalls = 0;
  const host = {
    appendChild(node) {
      nodes.set(node.id, node);
      if (node.tagName === "IFRAME") node.dispatch("load");
    },
  };
  const context = {
    Blob: class Blob {},
    URL: { createObjectURL: () => "blob:late-renderer" },
    document,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    setTimeout(callback) {
      timerCalls += 1;
      if (timerCalls === 1) document.body = host;
      queueMicrotask(callback);
      return timerCalls;
    },
    clearTimeout() {},
    queueMicrotask,
  };

  const expression = buildFrameExpression("mount", {
    html: "<!doctype html><title>Board</title>",
    layout: "sidebar",
    timeoutMs: 50,
  });
  const result = await runInNewContext(expression, context);
  assert.equal(result.status, "loaded");
  assert.equal(result.count, 1);
  assert.ok(timerCalls >= 1);
  const frame = nodes.get("projectboard-phase0-frame");
  assert.deepEqual(
    { width: frame.style.width, height: frame.style.height },
    { width: "1200px", height: "752px" },
    "the fallback must fill the viewport below the native top bar",
  );
});

test("an existing right-edge toggle is rebound when its iframe is recreated", async () => {
  const nodes = new Map();
  let mainRect = { left: 260, top: 48, width: 840, height: 700 };
  let resizeListener = null;
  const host = {
    appendChild(node) {
      nodes.set(node.id, node);
      if (node.tagName === "IFRAME") node.dispatch("load");
    },
  };
  const document = {
    body: host,
    documentElement: null,
    getElementById(id) { return nodes.get(id) ?? null; },
    querySelector(selector) {
      if (selector === "main") return { getBoundingClientRect: () => mainRect };
      return null;
    },
    querySelectorAll(selector) { return selector === "#projectboard-phase0-frame" ? [...nodes.values()].filter(({ id }) => id === "projectboard-phase0-frame") : []; },
    createElement(tagName) {
      const attributes = new Map();
      const listeners = new Map();
      return {
        tagName: tagName.toUpperCase(),
        id: "",
        src: "",
        style: {},
        hidden: false,
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        addEventListener(name, listener) { listeners.set(name, listener); },
        removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
        dispatch(name) { listeners.get(name)?.(); this[`on${name}`]?.(); },
        remove() { nodes.delete(this.id); },
      };
    },
  };
  const context = {
    Blob: class Blob {},
    URL: { createObjectURL: () => "blob:recreated-frame" },
    document,
    addEventListener(name, listener) { if (name === "resize") resizeListener = listener; },
    removeEventListener(name, listener) { if (name === "resize" && resizeListener === listener) resizeListener = null; },
    setTimeout(callback) { queueMicrotask(callback); return 1; },
    clearTimeout() {},
    queueMicrotask,
  };
  const expression = buildFrameExpression("mount", {
    html: "<!doctype html><title>Board</title>",
    layout: "sidebar",
    timeoutMs: 50,
  });

  assert.equal((await runInNewContext(expression, context)).status, "loaded");
  const firstFrame = nodes.get("projectboard-phase0-frame");
  const toggle = nodes.get("projectboard-phase1-toggle");
  assert.deepEqual(
    {
      left: firstFrame.style.left,
      top: firstFrame.style.top,
      width: firstFrame.style.width,
      height: firstFrame.style.height,
    },
    { left: "260px", top: "48px", width: "840px", height: "700px" },
    "an iframe is a replaced element, so its workspace dimensions must be explicit",
  );
  mainRect = { left: 220, top: 48, width: 880, height: 720 };
  resizeListener();
  assert.deepEqual(
    {
      left: firstFrame.style.left,
      top: firstFrame.style.top,
      width: firstFrame.style.width,
      height: firstFrame.style.height,
    },
    { left: "220px", top: "48px", width: "880px", height: "720px" },
    "the explicit iframe rectangle must follow workspace resizes",
  );
  nodes.delete("projectboard-phase0-frame");
  assert.equal((await runInNewContext(expression, context)).status, "loaded");
  const replacementFrame = nodes.get("projectboard-phase0-frame");
  assert.notEqual(replacementFrame, firstFrame);

  toggle.dispatch("click");
  assert.equal(replacementFrame.hidden, true, "the surviving toggle must collapse the replacement frame");
});
