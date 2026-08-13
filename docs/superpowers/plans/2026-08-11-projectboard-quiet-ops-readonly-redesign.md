# Projectboard Quiet Ops Read-Only Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every user-visible Codex conversation returned by the authenticated interactive catalog in a provably acknowledged Quiet Ops five-lane read-only workspace.

**Architecture:** Keep the Phase 0 package/account identity lock and the two-method renderer bridge, but request the App Server's interactive-source default instead of enumerating internal sources. Give each immutable projected snapshot a deterministic identity, require the sandboxed app to acknowledge initial and refreshed renders with matching IDs and counts, and promote a snapshot to “last good” only after acknowledgement. Replace the current multi-banner dashboard styling with the approved continuous Quiet Ops workspace while preserving the right-edge entry, honest lane projection, and sandbox boundary.

**Tech Stack:** Node.js ESM, `node:test`, generated Codex App Server JSON schema, Electron remote-debugging pipe/CDP, sandboxed offline HTML/CSS/JavaScript.

---

## File map

- Create `src/phase-1/catalog-policy.js`: one immutable definition of the user-visible interactive source filter.
- Modify `src/app-server/probe-readonly.js`: allow an empty generated source filter while preserving pagination and cursor guards.
- Modify `src/phase-1/desktop-bridge.js`: accept and send the empty interactive filter through the authenticated renderer bridge.
- Modify `src/phase-1/service.js`: retain schema identity binding but read the standalone catalog with the interactive filter.
- Modify `src/phase-1/sidebar-cli.js`: pass the interactive filter to the sidebar controller.
- Modify `src/phase-1/sidebar-controller.js`: require render acknowledgements, retain the last good snapshot/document, and mark stale data.
- Modify `src/phase-1/board-model.js`: deduplicate active/archive overlap and add a deterministic snapshot ID.
- Modify `src/cdp/targets.js`: distinguish iframe load from application readiness and wait for refresh acknowledgements.
- Modify `src/phase-1/embedded-board.js`: keep the embedded CSP offline while making it compatible with intentional sandbox framing.
- Modify `src/phase-1/ui/index.html`: provide the single-surface Quiet Ops structure.
- Modify `src/phase-1/ui/app.css`: implement the approved warm-neutral five-lane visual system and responsive state tabs.
- Modify `src/phase-1/ui/app.js`: validate counts, announce readiness/application, preserve stale snapshots, and render the revised structure.
- Modify `tests/unit/jsonl-peer.test.js`: cover paginated empty-source App Server requests.
- Modify `tests/unit/phase1-desktop-bridge.test.js`: cover interactive filtering and catalogs larger than one page.
- Modify `tests/unit/phase1-service.test.js`: prove identity binding and source selection remain separate.
- Modify `tests/unit/phase1-sidebar-cli.test.js`: prove the controller receives the interactive filter.
- Modify `tests/unit/phase1-board-model.test.js`: cover overlap deduplication, count agreement, and snapshot identity.
- Modify `tests/unit/phase1-embedded-board.test.js`: cover the embedded policy and application receipt contract.
- Modify `tests/unit/cdp-targets.test.js`: cover ready/applied receipts, timeouts, wrong sources, IDs, and counts.
- Modify `tests/unit/phase1-sidebar-controller.test.js`: cover last-good promotion, remount, stale state, and recovery.
- Modify `docs/phase-1-readonly-board.md`: document the new read and acknowledgement behavior.

## Guardrails for every task

- Do not run Phase 0 live probes.
- Do not create a Codex task or model turn.
- Do not run the skipped network-security tests.
- Do not open a remote-debugging TCP port.
- Do not add a task write, approval, archive, delete, resume, steer, interrupt, or Git-write path.
- Use only offline fixtures and the existing read-only test infrastructure until the final user-run safe restart.

### Task 1: Select the user-visible interactive conversation catalog

**Files:**
- Create: `src/phase-1/catalog-policy.js`
- Modify: `src/app-server/probe-readonly.js`
- Modify: `src/phase-1/desktop-bridge.js`
- Modify: `src/phase-1/service.js`
- Modify: `src/phase-1/sidebar-cli.js`
- Modify: `src/phase-1/sidebar-controller.js`
- Test: `tests/unit/jsonl-peer.test.js`
- Test: `tests/unit/phase1-desktop-bridge.test.js`
- Test: `tests/unit/phase1-service.test.js`
- Test: `tests/unit/phase1-sidebar-cli.test.js`

- [ ] **Step 1: Add failing tests for the interactive source policy**

Add assertions equivalent to the following exact contract:

```js
assert.deepEqual(INTERACTIVE_THREAD_SOURCE_KINDS, []);
assert.equal(Object.isFrozen(INTERACTIVE_THREAD_SOURCE_KINDS), true);

const expression = buildDesktopCatalogExpression([], {
  requestTimeoutMs: 100,
  maxPages: 4,
});
assert.match(expression, /"sourceKinds":\[\]/u);

assert.deepEqual(calls, [
  ["load", "C:\\evidence\\run"],
  ["bind", lock],
  ["read", candidate, []],
]);

assert.deepEqual(controllerOptions.sourceKinds, []);
```

In the desktop bridge fixture, return 100 rows with `nextCursor: "active-2"`, then one final active row; do the same for archived rows. Assert 101 active and 101 archived rows and assert that every `thread/list` request carries `sourceKinds: []`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test tests/unit/jsonl-peer.test.js tests/unit/phase1-desktop-bridge.test.js tests/unit/phase1-service.test.js tests/unit/phase1-sidebar-cli.test.js
```

Expected: FAIL because empty source arrays are rejected or the bound schema enum is still passed to catalog reads.

- [ ] **Step 3: Add the catalog policy and minimally route it**

Create `src/phase-1/catalog-policy.js` with:

```js
export const INTERACTIVE_THREAD_SOURCE_KINDS = Object.freeze([]);

export function validateThreadSourceFilter(value) {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || entry.length === 0)
    || new Set(value).size !== value.length) {
    throw new TypeError("sourceKinds must contain unique nonempty strings when supplied");
  }
  return value;
}
```

Use `validateThreadSourceFilter` in `desktop-bridge.js`. Remove only the `length === 0` rejection from the source validation inside `listAllThreadMetadata` in `probe-readonly.js`; keep the array, string, uniqueness, cursor, page-shape, and maximum-page checks unchanged.

In `service.js`, preserve `resolved.sourceKinds` for package/schema identity evidence but call:

```js
const catalog = await readCatalog(candidate, INTERACTIVE_THREAD_SOURCE_KINDS);
```

In `sidebar-cli.js`, pass:

```js
sourceKinds: INTERACTIVE_THREAD_SOURCE_KINDS,
```

In `sidebar-controller.js`, validate `sourceKinds` with `validateThreadSourceFilter` instead of requiring a non-empty array.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command.

Expected: all selected tests PASS; request evidence still contains only `initialize`, `initialized`, `account/read`, and `thread/list` where applicable.

- [ ] **Step 5: Commit the catalog policy**

```powershell
git add src/phase-1/catalog-policy.js src/app-server/probe-readonly.js src/phase-1/desktop-bridge.js src/phase-1/service.js src/phase-1/sidebar-cli.js src/phase-1/sidebar-controller.js tests/unit/jsonl-peer.test.js tests/unit/phase1-desktop-bridge.test.js tests/unit/phase1-service.test.js tests/unit/phase1-sidebar-cli.test.js
git commit -m "fix: read interactive Codex conversation catalog"
```

### Task 2: Deduplicate overlap and identify immutable snapshots

**Files:**
- Modify: `src/phase-1/board-model.js`
- Test: `tests/unit/phase1-board-model.test.js`

- [ ] **Step 1: Write failing projection tests**

Replace the old cross-collection duplicate rejection assertion with:

```js
const snapshot = buildReadonlyBoardSnapshot({
  activeThreads: [thread({ id: "shared", updatedAt: 300 })],
  archivedThreads: [
    thread({ id: "shared", updatedAt: 200 }),
    thread({ id: "archived-only", updatedAt: 100 }),
  ],
  identity,
  generatedAt: "2026-08-11T00:00:00.000Z",
});

assert.equal(snapshot.summary.activeThreadCount, 1);
assert.equal(snapshot.summary.archivedThreadCount, 1);
assert.equal(snapshot.summary.taskCount, 2);
assert.equal(snapshot.aggregate.counts.total, 2);
assert.match(snapshot.snapshotId, /^[0-9a-f]{64}$/u);
assert.equal(
  snapshot.aggregate.lanes.flatMap(({ tasks }) => tasks)
    .find(({ id }) => id === "shared").archived,
  false,
);
```

Build the same input twice with the same `generatedAt` and assert equal `snapshotId`; change one `updatedAt` and assert a different ID. Retain rejection tests for duplicates within the active collection and within the archived collection.

- [ ] **Step 2: Run the model test and verify RED**

Run:

```powershell
node --test tests/unit/phase1-board-model.test.js
```

Expected: FAIL with `ETHREADDUPLICATE` and missing `snapshotId`.

- [ ] **Step 3: Implement stable cross-collection deduplication**

Track collection-local IDs separately:

```js
const activeIds = new Set();
const archivedIds = new Set();

for (const thread of activeThreads) {
  if (activeIds.has(thread.id)) throw codedError("ETHREADDUPLICATE", `thread ${thread.id} repeated in active catalog`);
  activeIds.add(thread.id);
  add(thread, false);
}

for (const thread of archivedThreads) {
  if (archivedIds.has(thread.id)) throw codedError("ETHREADDUPLICATE", `thread ${thread.id} repeated in archived catalog`);
  archivedIds.add(thread.id);
  if (!activeIds.has(thread.id)) add(thread, true);
}
```

Set `activeThreadCount` to `activeIds.size`, `archivedThreadCount` to the number of archived IDs not present in `activeIds`, and `taskCount` to the final `seen.size`.

- [ ] **Step 4: Add the canonical snapshot ID**

Build the return payload before freezing it:

```js
const payload = {
  schemaVersion: 1,
  mode: "standalone-readonly",
  generatedAt,
  source,
  summary,
  aggregate,
  projects: Object.freeze(projectedProjects),
};
const snapshotId = createHash("sha256")
  .update(JSON.stringify(payload), "utf8")
  .digest("hex");
return Object.freeze({ ...payload, snapshotId });
```

All nested values placed in `payload` must already be frozen using the current model pattern.

- [ ] **Step 5: Run the model and service tests**

```powershell
node --test tests/unit/phase1-board-model.test.js tests/unit/phase1-service.test.js
```

Expected: PASS with deterministic 64-character snapshot IDs and count agreement.

- [ ] **Step 6: Commit the snapshot contract**

```powershell
git add src/phase-1/board-model.js tests/unit/phase1-board-model.test.js
git commit -m "feat: identify deduplicated board snapshots"
```

### Task 3: Make the sandboxed application acknowledge real renders

**Files:**
- Modify: `src/phase-1/ui/app.js`
- Modify: `src/phase-1/embedded-board.js`
- Test: `tests/unit/phase1-embedded-board.test.js`

- [ ] **Step 1: Write failing embedded contract tests**

Extend the composed-document assertions with:

```js
assert.doesNotMatch(document, /frame-ancestors 'none'/u);
assert.match(document, /projectboard-readonly-ready/u);
assert.match(document, /projectboard-readonly-applied/u);
assert.match(document, /sourceTaskCount/u);
assert.match(document, /renderedTaskCount/u);
assert.match(document, /snapshotId/u);
assert.match(document, /updateId/u);
assert.match(document, /projectboard-readonly-stale/u);
```

Retain these explicit safety and ordering assertions:

```js
assert.match(document, /connect-src 'none'/u);
assert.equal(document.includes("http://"), false);
assert.equal(document.includes("https://"), false);
assert.equal(document.includes('href="/app.css"'), false);
assert.equal(document.includes('src="/app.js"'), false);
assert.match(document, /\\u003c\/script\\u003e/u);
assert.ok(document.indexOf("data-projectboard-app") > document.indexOf('id="workspace"'));
```

- [ ] **Step 2: Run the embedded test and verify RED**

```powershell
node --test tests/unit/phase1-embedded-board.test.js
```

Expected: FAIL because the embedded app has no receipt protocol and the contradictory meta directive remains.

- [ ] **Step 3: Validate snapshot counts in `app.js`**

Add these focused helpers before `applySnapshot`:

```js
function receiptFor(snapshot) {
  if (typeof snapshot?.snapshotId !== "string" || !/^[0-9a-f]{64}$/u.test(snapshot.snapshotId)) {
    throw new Error("看板快照标识无效");
  }
  const tasks = snapshot.aggregate.lanes.flatMap(({ tasks: laneTasks }) => laneTasks);
  const ids = new Set(tasks.map(({ id }) => id));
  if (ids.size !== tasks.length
    || ids.size !== snapshot.summary.taskCount
    || ids.size !== snapshot.aggregate.counts.total) {
    throw new Error("看板任务数量不一致");
  }
  return Object.freeze({
    snapshotId: snapshot.snapshotId,
    sourceTaskCount: snapshot.summary.taskCount,
    renderedTaskCount: ids.size,
  });
}

function postReceipt(type, receipt, extra = {}) {
  if (globalThis.parent === globalThis) return;
  globalThis.parent.postMessage({ type, ...extra, ...receipt }, "*");
}
```

Make `applySnapshot` clear `state.stale`, render, and return `receiptFor(snapshot)` after rendering.

- [ ] **Step 4: Announce boot, refresh, and stale state**

Use this exact message flow:

```js
async function boot() {
  let snapshot = globalThis.__PROJECTBOARD_SNAPSHOT__ ?? null;
  if (snapshot === null) {
    const token = location.hash.slice(1);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    if (!token) throw new Error("访问令牌缺失。请从 Projectboard 启动命令输出的完整地址重新打开。");
    const response = await fetch("/api/board", {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`读取只读看板失败（HTTP ${response.status}）`);
    snapshot = await response.json();
  }
  const receipt = applySnapshot(snapshot);
  postReceipt("projectboard-readonly-ready", receipt);
}

globalThis.addEventListener("message", (event) => {
  if (globalThis.parent === globalThis || event.source !== globalThis.parent) return;
  if (event.data?.type === "projectboard-readonly-stale") {
    state.stale = true;
    renderSyncStatus();
    return;
  }
  if (event.data?.type !== "projectboard-readonly-snapshot"
    || typeof event.data.updateId !== "string"
    || event.data.updateId.length === 0) return;
  try {
    const receipt = applySnapshot(event.data.snapshot);
    postReceipt("projectboard-readonly-applied", receipt, { updateId: event.data.updateId });
  } catch (error) {
    fail(error?.message ?? String(error));
  }
});
```

Add `stale: false` to state. `renderSyncStatus()` must show `数据已过期 · 最后快照 HH:mm:ss` while stale and the existing `快照 HH:mm:ss` text otherwise.

- [ ] **Step 5: Remove only the incompatible embedded directive**

Change `EMBEDDED_CSP` to:

```js
const EMBEDDED_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
```

Do not change the standalone HTTP CSP in `readonly-server.js`.

- [ ] **Step 6: Run the embedded and model tests**

```powershell
node --test tests/unit/phase1-embedded-board.test.js tests/unit/phase1-board-model.test.js
```

Expected: PASS; the document remains offline and the receipt strings appear after the DOM.

- [ ] **Step 7: Commit the embedded receipt protocol**

```powershell
git add src/phase-1/ui/app.js src/phase-1/embedded-board.js tests/unit/phase1-embedded-board.test.js
git commit -m "feat: acknowledge rendered board snapshots"
```

### Task 4: Require receipts in CDP and preserve the last good snapshot

**Files:**
- Modify: `src/cdp/targets.js`
- Modify: `src/phase-1/sidebar-controller.js`
- Test: `tests/unit/cdp-targets.test.js`
- Test: `tests/unit/phase1-sidebar-controller.test.js`

- [ ] **Step 1: Write failing CDP receipt tests**

Add a message-capable fake frame and parent event target. The mount test must dispatch `load` first and remain unsettled until it dispatches:

```js
window.dispatchMessage({
  source: frame.contentWindow,
  data: {
    type: "projectboard-readonly-ready",
    snapshotId: snapshot.snapshotId,
    sourceTaskCount: snapshot.summary.taskCount,
    renderedTaskCount: snapshot.summary.taskCount,
  },
});
```

Assert wrong `source`, wrong `snapshotId`, and unequal counts do not produce `loaded`. Add an update test that passes `updateId: "update-1"`, inspects the posted envelope, dispatches `projectboard-readonly-applied`, and expects `{ status: "updated", updated: true }` only after the exact receipt.

Retain the old load-only behavior for `layout: "probe"` mounts that do not receive a snapshot; Phase 0 fixture behavior must not change.

- [ ] **Step 2: Write failing controller promotion tests**

Extend the injected fake peer/evaluator behavior so that:

1. an initial mount without a ready result rejects startup;
2. a refresh with zero applied acknowledgements rejects and keeps `controller.initialSnapshot.snapshotId` as the working snapshot;
3. a later acknowledged refresh emits `refreshed` and becomes the snapshot used for remount;
4. a failed refresh posts the stale message without deleting the frame.

The successful fixture result must include matching receipt evidence:

```js
{
  status: "loaded",
  count: 1,
  snapshotId: snapshot.snapshotId,
  renderedTaskCount: snapshot.summary.taskCount,
}
```

- [ ] **Step 3: Run the CDP/controller tests and verify RED**

```powershell
node --test tests/unit/cdp-targets.test.js tests/unit/phase1-sidebar-controller.test.js
```

Expected: FAIL because iframe load and immediate `postMessage` are still treated as success.

- [ ] **Step 4: Add snapshot receipt validation to `targets.js`**

Add one build-time validator:

```js
function snapshotReceipt(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || typeof snapshot.snapshotId !== "string"
    || !/^[0-9a-f]{64}$/u.test(snapshot.snapshotId)
    || !Number.isSafeInteger(snapshot.summary?.taskCount)
    || snapshot.summary.taskCount < 0) {
    throw new TypeError("a snapshot with a valid receipt identity is required");
  }
  return { snapshotId: snapshot.snapshotId, taskCount: snapshot.summary.taskCount };
}
```

For sidebar mounts with a snapshot, register a parent `message` listener before assigning `frame.src`. Finish `loaded` only for the exact frame source, ready type, snapshot ID, and equal source/rendered/expected counts. Clean up load, error, message, and timeout listeners in every settlement path. Keep load-only completion when no snapshot receipt is supplied.

Change update expressions to return a promise, post `{ type: "projectboard-readonly-snapshot", updateId, snapshot }`, and settle only on the matching applied receipt. Add a `stale` action that posts `{ type: "projectboard-readonly-stale", snapshotId }` to an existing frame and returns `{ status: "stale", posted: true }`; it carries no task content and does not count as a snapshot update.

- [ ] **Step 5: Make controller promotion atomic**

Import `randomUUID` from `node:crypto`. Change the helpers to these signatures:

```js
const mountSession = async (sessionId, html, snapshot) => { /* acknowledged mount */ };
const markSessionsStale = async (snapshot) => { /* best-effort stale action */ };
```

Pass `latestSnapshot` into every initial or remount call. During refresh:

```js
const candidateSnapshot = await createSnapshot();
const candidateDocument = await buildDocument(candidateSnapshot);
const updateId = randomUUID();
const expression = buildFrameExpression("update", {
  snapshot: candidateSnapshot,
  updateId,
  timeoutMs: 5_000,
});
// Evaluate every session and collect exact acknowledgements.
if (updates.length === 0) throw new Error("No Codex renderer acknowledged the board snapshot");
latestSnapshot = candidateSnapshot;
latestDocument = candidateDocument;
```

On catalog, document, or acknowledgement failure, call `markSessionsStale(latestSnapshot)`, keep both last-good variables unchanged, emit `refreshError`, and rethrow. On success, the application receipt clears its stale state.

- [ ] **Step 6: Run the receipt and controller tests**

```powershell
node --test tests/unit/cdp-targets.test.js tests/unit/phase1-sidebar-controller.test.js tests/unit/phase1-embedded-board.test.js
```

Expected: PASS for exact receipt acknowledgement, load-only probe compatibility, stale retention, remount, and recovery.

- [ ] **Step 7: Commit the reliable delivery boundary**

```powershell
git add src/cdp/targets.js src/phase-1/sidebar-controller.js tests/unit/cdp-targets.test.js tests/unit/phase1-sidebar-controller.test.js
git commit -m "fix: require sidebar render acknowledgements"
```

### Task 5: Implement the Quiet Ops five-lane workspace

**Files:**
- Modify: `src/phase-1/ui/index.html`
- Modify: `src/phase-1/ui/app.css`
- Modify: `src/phase-1/ui/app.js`
- Modify: `tests/unit/phase1-embedded-board.test.js`
- Modify: `tests/integration/phase1-readonly-server.test.js`

- [ ] **Step 1: Write failing structure and style assertions**

Assert the built embedded and standalone documents contain the new structure and omit the old chrome:

```js
assert.match(document, /class="app-bar"/u);
assert.match(document, /class="attention-rail"/u);
assert.match(document, /class="board-grid"/u);
assert.match(document, /data-visual-direction="quiet-ops"/u);
assert.doesNotMatch(document, /boundary-banner/u);
assert.doesNotMatch(document, /mode-badge/u);
assert.match(document, /--accent:\s*#e44c34/iu);
assert.match(document, /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/iu);
assert.match(document, /Segoe UI Variable/u);
assert.match(document, /@media\s*\(max-width:\s*699px\)/u);
```

Retain these behavior assertions alongside the new visual assertions:

```js
assert.match(document, /all-history/u);
assert.match(document, /全部历史/u);
const suppliedThreadIds = snapshot.aggregate.lanes.flatMap(({ tasks }) => tasks.map(({ threadId }) => threadId));
for (const threadId of suppliedThreadIds) assert.match(document, new RegExp(threadId, "u"));
assert.doesNotMatch(document, /turn\/start|thread\/start|thread\/archive|thread\/delete/u);
assert.doesNotMatch(document, /https?:\/\/(?!127\.0\.0\.1)/u);
```

- [ ] **Step 2: Run UI-related tests and verify RED**

```powershell
node --test tests/unit/phase1-embedded-board.test.js tests/integration/phase1-readonly-server.test.js
```

Expected: FAIL on missing Quiet Ops structure and the still-present boundary banner.

- [ ] **Step 3: Replace the shell with one continuous workspace**

Use this primary body structure in `index.html`, retaining the existing IDs required by `app.js` and the detail dialog after `main`:

```html
<body data-visual-direction="quiet-ops">
  <div id="fatal-error" class="fatal-error" role="alert" hidden></div>
  <main id="workspace" class="workspace" hidden>
    <section class="board-shell" aria-labelledby="project-title">
      <header class="app-bar">
        <div class="title-block">
          <span class="brand-mark" aria-hidden="true"></span>
          <div>
            <h1>任务面板</h1>
            <p id="catalog-summary">正在读取历史任务…</p>
          </div>
        </div>
        <div class="toolbar">
          <label class="project-picker" for="project-select">
            <span class="visually-hidden">选择工作目录</span>
            <select id="project-select"><option value="all-history">全部历史 · 0</option></select>
          </label>
          <label class="search-field"><span class="visually-hidden">搜索任务</span><input id="search-input" type="search" autocomplete="off" placeholder="搜索任务"></label>
          <label class="archive-filter"><input id="archive-toggle" type="checkbox" checked><span>含归档</span></label>
        </div>
      </header>
      <div class="context-row">
        <div><h2 id="project-title" tabindex="-1">全部历史</h2><p id="project-path">所有工作目录</p></div>
        <p id="sync-status" aria-live="polite">正在读取本地快照…</p>
      </div>
      <section class="attention-rail" aria-labelledby="attention-title">
        <h3 id="attention-title">需要我处理 <span id="attention-total">0</span></h3>
        <div id="attention-list" class="attention-list"></div>
      </section>
      <nav id="lane-tabs" class="lane-tabs" aria-label="任务状态"></nav>
      <div id="lanes" class="board-grid" aria-label="五栏任务看板"></div>
    </section>
  </main>
  <dialog id="task-dialog" class="task-dialog" aria-labelledby="dialog-title">
    <div class="dialog-heading">
      <div><p id="dialog-kicker" class="eyebrow">THREAD</p><h2 id="dialog-title">任务详情</h2></div>
      <button id="dialog-close" class="icon-button" type="button" aria-label="关闭详情">×</button>
    </div>
    <p id="dialog-attention" class="dialog-attention" hidden></p>
    <section class="detail-section"><h3>明确下一步</h3><p id="dialog-next-action"></p></section>
    <dl class="detail-grid">
      <div><dt>任务状态</dt><dd id="dialog-state"></dd></div>
      <div><dt>Codex 状态</dt><dd id="dialog-source-status"></dd></div>
      <div><dt>最后活动</dt><dd id="dialog-updated"></dd></div>
      <div><dt>Projectboard 投影</dt><dd id="dialog-archive"></dd></div>
    </dl>
    <section class="detail-section">
      <h3>原 Codex 任务 ID</h3>
      <code id="dialog-thread-id" class="thread-id"></code>
      <p class="muted">当前安全边界不调用未经验证的桌面深链；请在 Codex 任务列表中按此 ID 定位。</p>
    </section>
  </dialog>
</body>
```

- [ ] **Step 4: Apply the Quiet Ops tokens and layout**

Replace the top-level styling tokens and board layout with:

```css
:root {
  color-scheme: light dark;
  --surface: #f8f7f3;
  --surface-raised: #ffffff;
  --surface-muted: #eeede8;
  --ink: #1d1e1b;
  --muted: #74756f;
  --rule: #d9d7cf;
  --accent: #e44c34;
  --accent-soft: #fff0ec;
  --shadow: 0 2px 5px rgb(20 20 18 / 4%);
  font-family: "Segoe UI Variable", "Microsoft YaHei UI", "Segoe UI", sans-serif;
}

html, body { width: 100%; height: 100%; overflow: hidden; }
body { margin: 0; background: var(--surface); color: var(--ink); }
.workspace, .board-shell { width: 100%; height: 100%; min-width: 0; }
.board-shell { display: grid; grid-template-rows: auto auto auto auto minmax(0, 1fr); overflow: hidden; }
.app-bar { display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: 16px; align-items: center; min-height: 58px; padding: 10px 16px; border-bottom: 1px solid var(--rule); }
.context-row { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 16px; min-height: 42px; padding: 7px 16px; border-bottom: 1px solid var(--rule); }
.attention-rail { display: flex; min-width: 0; align-items: center; gap: 12px; min-height: 34px; padding: 6px 16px; border-bottom: 1px solid var(--rule); }
.board-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); min-width: 0; min-height: 0; overflow: hidden; }
.lane { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; border-right: 1px solid var(--rule); }
.lane:last-child { border-right: 0; }
.lane-list { min-width: 0; min-height: 0; overflow: auto; padding: 8px; }
.task-card { border: 1px solid var(--rule); border-radius: 4px; background: var(--surface-raised); box-shadow: var(--shadow); }
.task-card[data-active="true"] { border-color: var(--accent); }

.lane-tabs { display: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

@media (prefers-color-scheme: dark) {
  :root {
    --surface: #151714;
    --surface-raised: #1d201c;
    --surface-muted: #252823;
    --ink: #eef0eb;
    --muted: #989f97;
    --rule: #343832;
    --accent-soft: #38211c;
    --shadow: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    transition-duration: .01ms !important;
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
  }
}

@media (max-width: 699px) {
  .app-bar { grid-template-columns: 1fr; gap: 8px; }
  .toolbar { display: grid; grid-template-columns: 1fr 1fr; }
  .search-field { grid-column: 1 / -1; }
  .attention-rail { align-items: flex-start; }
  .lane-tabs { display: flex; min-width: 0; overflow-x: auto; border-bottom: 1px solid var(--rule); }
  .board-grid { display: block; overflow: hidden; }
  .lane { width: 100%; height: 100%; border-right: 0; }
  .lane[hidden] { display: none; }
}
```

Do not add gradients, remote fonts, emoji, decorative statistic tiles, or whole-board horizontal scrolling.

- [ ] **Step 5: Align rendering class names and honest empty states**

In `app.js`, emit `lane-list`, `task-card`, and `data-active="true"` for active tasks. For an empty lane, render exactly one quiet explanation based on lane ID:

```js
const emptyMessages = new Map([
  ["inbox", "没有符合当前筛选的历史任务"],
  ["planned", "只读目录不会凭标题猜测计划状态"],
  ["running", "当前没有 Codex 正在执行的任务"],
  ["review", "等待未来经过安全门槛的明确状态"],
  ["done", "历史对话仍可在收集箱中完整检索"],
]);
```

Keep the existing `showTask(project, task)` dialog-only call sites and the strict parent-message source check. Delete only element lookups or rendering calls for `boundary-banner`, `mode-badge`, and the removed multi-banner header; add no bridge call to task activation.

- [ ] **Step 6: Run the UI tests and focused Phase 1 suite**

```powershell
node --test tests/unit/phase1-embedded-board.test.js tests/integration/phase1-readonly-server.test.js tests/unit/phase1-board-model.test.js
```

Expected: PASS with the Quiet Ops structure, all-history default, searchable supplied tasks, offline assets, and five-lane grid.

- [ ] **Step 7: Commit the visual redesign**

```powershell
git add src/phase-1/ui/index.html src/phase-1/ui/app.css src/phase-1/ui/app.js tests/unit/phase1-embedded-board.test.js tests/integration/phase1-readonly-server.test.js
git commit -m "feat: redesign projectboard as quiet ops workspace"
```

### Task 6: Document, visually verify, review, and finish

**Files:**
- Modify: `docs/phase-1-readonly-board.md`
- Verify: all changed source and test files from Tasks 1–5

- [ ] **Step 1: Update the operator documentation**

Document these exact behaviors in `docs/phase-1-readonly-board.md`:

```markdown
- Catalog reads use the App Server interactive-source default, fully paginate active and archived results, and exclude internal subagent records.
- “Mounted” means the sandboxed app acknowledged the exact snapshot ID and task count; iframe load alone is not success.
- Refresh failures keep the last acknowledged board visible and mark its timestamp as stale.
- The Quiet Ops workspace keeps the right-edge handle, native left navigation, five evidence-based lanes, and the Phase 0 read-only No-Go boundary.
```

Retain the launcher, package identity, no-debug-port, and no-write operating instructions.

- [ ] **Step 2: Run the complete focused suite**

```powershell
node --test tests/unit/jsonl-peer.test.js tests/unit/cdp-targets.test.js tests/unit/phase1-*.test.js tests/integration/phase1-readonly-server.test.js tests/integration/cdp-pipe.test.js
```

Expected: all tests PASS, with only the repository's deliberate platform skip if it is selected.

- [ ] **Step 3: Start an offline fake-catalog board for visual verification**

In the persistent local Node browser-development context, run this offline fixture code:

```js
const { pathToFileURL } = await import("node:url");
const projectboardRoot = "C:/path/to/codex-projectboard";
const { buildReadonlyBoardSnapshot } = await import(pathToFileURL(`${projectboardRoot}/src/phase-1/board-model.js`).href);
const { startReadonlyBoardServer } = await import(pathToFileURL(`${projectboardRoot}/src/phase-1/readonly-server.js`).href);
const identity = {
  phase0RunId: "offline-visual-fixture",
  standalonePhase1: "go-with-readonly-degradation",
  injectedPhase1: "no-go",
  candidateVersion: "offline-fixture",
  executionDigest: "a".repeat(64),
  accountType: "chatgpt",
  outboundMethods: ["account/read", "thread/list", "thread/list"],
};
const makeThread = (index, overrides = {}) => ({
  id: `visual-${index}`,
  name: `历史任务 ${index} · 检查较长中文标题在五栏工作区中的换行与层级表现`,
  preview: `历史任务 ${index}`,
  cwd: `C:\\Work\\Project-${index % 3}`,
  createdAt: 1_786_000_000 + index,
  updatedAt: 1_786_100_000 + index,
  status: { type: "idle" },
  ...overrides,
});
const snapshot = buildReadonlyBoardSnapshot({
  activeThreads: [
    ...Array.from({ length: 11 }, (_, index) => makeThread(index)),
    makeThread(11, { status: { type: "active", activeFlags: ["waitingOnUserInput"] } }),
  ],
  archivedThreads: [makeThread(12, { id: "visual-archived", cwd: "C:\\Work\\Archive" })],
  identity,
  generatedAt: "2026-08-11T12:00:00.000Z",
});
globalThis.projectboardVisualServer = await startReadonlyBoardServer({ snapshot });
globalThis.projectboardVisualUrl = projectboardVisualServer.url;
```

Open `projectboardVisualUrl` in the existing in-app browser local-development session. The returned server binds only `127.0.0.1` on a random port and does not connect to Codex or any external network.

Verify at these viewports using the existing in-app browser local-web workflow:

```text
824 × 752  — five simultaneous equal lanes, no workspace horizontal overflow
1200 × 800 — balanced density and independent lane scrolling
680 × 752  — state tabs visible, one lane visible, keyboard focus retained
```

Expected visual result: Quiet Ops warm-neutral hierarchy, one orange-red accent, compact app bar and attention rail, crisp task titles, honest empty lanes, and no thick boundary banner.

- [ ] **Step 4: Run the full repository verification**

```powershell
npm.cmd test
git diff --check
git status --short
```

Expected: the full suite passes with the known deliberate skip only; `git diff --check` prints nothing; status contains only intended documentation changes before the final commit.

- [ ] **Step 5: Review the complete branch diff**

Review from the design commit:

```powershell
git diff b7910dc -- src tests docs/phase-1-readonly-board.md
```

Confirm all of the following before committing:

```text
No methods outside account/read and thread/list
No TCP debug port or alternate profile
No task, model-turn, approval, archive, delete, or Git write path
No remote UI asset or network request
No iframe-load-only success path for the sidebar
No snapshot promotion without an exact applied acknowledgement
No invented planned/review/done state
```

- [ ] **Step 6: Commit documentation and verification adjustments**

```powershell
git add docs/phase-1-readonly-board.md
git commit -m "docs: describe acknowledged quiet ops sidebar"
```

- [ ] **Step 7: Report readiness for one user-run safe restart**

Report the final commit list, focused/full test counts, the three viewport results, and the unchanged No-Go boundary. Ask the user to close Codex and relaunch once through `E:\Desktop\Codex 五栏任务看板（只读）.cmd`; do not kill the active Codex process from this task.
