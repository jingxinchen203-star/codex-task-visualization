import test from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import {
  buildEmbeddedBoardDocument,
  buildStaticEmbeddedBoardDocument,
  composeEmbeddedBoardDocument,
  composeStaticEmbeddedBoardDocument,
} from "../../src/phase-1/embedded-board.js";

const shell = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>
<body><span>只读 · 独立窗口</span><p>Phase 1 降级边界：仅浏览线程元数据；不注入 Codex，不创建 turn，不改变任务状态，不写 Git。</p></body></html>`;

const appElementIds = [
  "workspace",
  "fatal-error",
  "sync-status",
  "catalog-summary",
  "project-select",
  "project-title",
  "project-path",
  "search-input",
  "archive-toggle",
  "attention-total",
  "attention-list",
  "lane-tabs",
  "lanes",
  "task-dialog",
  "dialog-close",
  "dialog-kicker",
  "dialog-title",
  "dialog-attention",
  "dialog-next-action",
  "dialog-state",
  "dialog-source-status",
  "dialog-updated",
  "dialog-archive",
  "dialog-thread-id",
];
const canonicalLaneIds = ["inbox", "planned", "running", "review", "done"];

function assertQuietOpsDocument(document) {
  assert.match(document, /class="app-bar"/u);
  assert.match(document, /class="attention-rail"/u);
  assert.match(document, /class="board-grid"/u);
  assert.match(document, /data-visual-direction="quiet-ops"/u);
  assert.doesNotMatch(document, /boundary-banner/u);
  assert.doesNotMatch(document, /mode-badge/u);
  assert.match(document, /--surface:\s*#f7f7f8/iu);
  assert.match(document, /--ink:\s*#18181b/iu);
  assert.match(document, /--accent:\s*#2563eb/iu);
  assert.match(document, /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/iu);
  assert.match(document, /Segoe UI Variable/u);
  assert.match(document, /@media\s*\(max-width:\s*699px\)/u);
  assert.match(document, /--muted:\s*#5f6068/iu);
  assert.match(document, /--attention-ink:\s*#9f1239/iu);
  assert.match(document, /@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*--surface:\s*#111113/iu);
  assert.match(document, /@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*--attention-ink:\s*#fda4af/iu);
  assert.doesNotMatch(document, /#151714|#1d201c|#252823/iu);
  assert.match(document, /#attention-total\s*\{[^}]*color:\s*var\(--attention-ink\)/isu);
  assert.match(document, /\.attention-item strong\s*\{[^}]*color:\s*var\(--attention-ink\)/isu);
  assert.match(document, /\.task-badge\.attention\s*,\s*\.task-badge\.active\s*\{[^}]*color:\s*var\(--attention-ink\)/isu);
  assert.match(document, /\.dialog-attention\s*\{[^}]*color:\s*var\(--attention-ink\)/isu);
  assert.doesNotMatch(document, /[;{]\s*color:\s*var\(--accent\)/iu);
  assert.match(document, /\.task-card-title,\s*\.task-next\s*\{[^}]*overflow-wrap:\s*anywhere/isu);
  const taskCardRule = /\.task-card\s*\{([^}]*)\}/isu.exec(document);
  assert.ok(taskCardRule, "task cards must have a dedicated visual rule");
  assert.match(taskCardRule[1], /width:\s*100%/iu);
  assert.match(taskCardRule[1], /text-align:\s*left/iu);
  assert.match(taskCardRule[1], /font:\s*inherit/iu);
  assert.match(taskCardRule[1], /color:\s*inherit/iu);
  assert.doesNotMatch(document, /card\.addEventListener\("keydown"/u);
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../gu).map((channel) => Number.parseInt(channel, 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
    .sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.hidden = false;
    this.value = "";
    this.checked = false;
    this.selected = false;
    this.className = "";
    this.tabIndex = 0;
    this._textContent = "";
    this.appendError = null;
    this.focused = false;
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = value == null ? "" : String(value);
    this.children = [];
  }

  replaceChildren(...children) {
    this._textContent = "";
    this.children = [...children];
  }

  append(...children) {
    if (this.appendError) {
      const error = this.appendError;
      this.appendError = null;
      throw error;
    }
    this.children.push(...children);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click() {
    for (const listener of this.listeners.get("click") ?? []) listener({ target: this });
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  querySelectorAll(selector) {
    if (selector !== ".lane") return [];
    return descendants(this).filter(({ className }) => className.split(/\s+/u).includes("lane"));
  }

  querySelector(selector) {
    const match = /^\[data-lane="([^"]+)"\]$/u.exec(selector);
    if (!match) return null;
    return descendants(this).find(({ dataset }) => dataset.lane === match[1]) ?? null;
  }

  focus() {
    this.focused = true;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }
}

function descendants(element) {
  return element.children.flatMap((child) => child instanceof FakeElement
    ? [child, ...descendants(child)]
    : []);
}

function elementText(element) {
  return [element.textContent, ...element.children.map((child) => (
    child instanceof FakeElement ? elementText(child) : String(child)
  ))].join(" ");
}

function boardTask(id, title = `Task ${id}`) {
  return {
    id,
    projectId: "project-1",
    title,
    nextAction: "Inspect metadata",
    threadId: id,
    state: "inbox",
    sourceStatus: "idle",
    updatedAt: 1_786_406_400_000,
    archived: false,
    attention: null,
  };
}

function boardLanes(tasks = []) {
  return canonicalLaneIds.map((id) => ({
    id,
    label: id,
    description: `${id} lane`,
    tasks: id === "inbox" ? tasks : [],
  }));
}

function boardProject(id, tasks, lanes = boardLanes(tasks)) {
  return {
    id,
    name: `Project ${id}`,
    workspace: `C:\\${id}`,
    counts: { total: tasks.length },
    lanes,
  };
}

function boardSnapshot(options = {}) {
  const tasks = options.tasks ?? [boardTask("task-1", "Initial task")];
  const projects = options.projects ?? [boardProject("project-1", tasks)];
  return {
    mode: "standalone-readonly",
    snapshotId: options.snapshotId ?? "a".repeat(64),
    generatedAt: options.generatedAt ?? "2026-08-11T00:00:00.000Z",
    source: { candidateVersion: "test", phase0RunId: "run" },
    summary: {
      projectCount: projects.length,
      taskCount: options.taskCount ?? tasks.length,
      activeThreadCount: tasks.length,
      archivedThreadCount: 0,
      attentionCount: 0,
    },
    aggregate: {
      id: "all-history",
      name: "全部历史",
      workspace: "所有工作目录",
      counts: {
        total: options.total ?? tasks.length,
        attention: 0,
        running: 0,
        archived: 0,
      },
      lanes: options.aggregateLanes ?? boardLanes(tasks),
    },
    projects,
  };
}

test("static embedded board renders one scriptless exact five-lane snapshot", async () => {
  const task = {
    ...boardTask("task-<&-1", "Review <script>alert(1)</script> & history"),
    nextAction: 'Inspect "all" metadata',
    sourceStatus: "active",
    attention: { label: "需要处理 & 核对" },
  };
  const snapshot = boardSnapshot({ tasks: [task] });
  const document = composeStaticEmbeddedBoardDocument(snapshot, { styles: ":root { color: black; }" });

  assert.match(document, /<html[^>]*data-projectboard-static="true"/u);
  assert.match(document, new RegExp(`data-projectboard-snapshot-id="${snapshot.snapshotId}"`, "u"));
  assert.match(document, /data-projectboard-rendered-task-count="1"/u);
  assert.equal((document.match(/data-projectboard-lane=/gu) ?? []).length, 5);
  assert.equal((document.match(/data-projectboard-task-id=/gu) ?? []).length, 1);
  assert.match(document, /data-projectboard-task-id="task-&lt;&amp;-1"/u);
  assert.match(document, /data-projectboard-thread-id="task-&lt;&amp;-1"/u);
  assert.match(document, /href="#projectboard-open\/task-%3C%26-1"/u);
  assert.match(document, /class="task-open-link" draggable="false" href=/u);
  assert.match(document, /class="task-move-menu"/u);
  assert.equal((document.match(/data-projectboard-move-lane=/gu) ?? []).length, 4);
  assert.equal((document.match(/data-projectboard-move-thread=/gu) ?? []).length, 4);
  assert.match(document, /type="radio" name="projectboard-move-request"[^>]*data-projectboard-move-thread="task-&lt;&amp;-1"[^>]*data-projectboard-move-lane="planned"/u);
  assert.doesNotMatch(document, /href="#projectboard-move/u);
  assert.doesNotMatch(document, /projectboard-drag/u);
  assert.doesNotMatch(document, /codex:\/\/threads/u);
  assert.doesNotMatch(document, /data-projectboard-drop-lane/u);
  assert.match(document, /Codex 只读 · 本地编排/u);
  assert.match(document, /Review &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; history/u);
  assert.match(document, /Inspect &quot;all&quot; metadata/u);
  assert.match(document, /活动中/u);
  assert.match(document, /需要处理 &amp; 核对/u);
  assert.doesNotMatch(document, /<script\b/iu);
  assert.match(document, /script-src 'none'/u);

  const built = await buildStaticEmbeddedBoardDocument(snapshot);
  assertQuietOpsDocument(built);
  assert.match(built, /\.task-move-option\s*\{/u);
  assert.doesNotMatch(built, /<script\b/iu);
  assert.equal((built.match(/data-projectboard-task-id=/gu) ?? []).length, 1);
});

function invalidTopologySnapshots() {
  const taskA = boardTask("task-a", "Invalid candidate A");
  const taskB = boardTask("task-b", "Invalid candidate B");
  const duplicateAggregateLanes = boardLanes([taskA]);
  duplicateAggregateLanes[4] = { ...duplicateAggregateLanes[4], id: "review" };
  const unknownAggregateLanes = boardLanes([taskA]);
  unknownAggregateLanes[4] = { ...unknownAggregateLanes[4], id: "waiting" };
  const duplicateProjectLanes = boardLanes([taskA]);
  duplicateProjectLanes[4] = { ...duplicateProjectLanes[4], id: "review" };

  return [
    {
      name: "duplicate aggregate lane ID",
      snapshot: boardSnapshot({
        snapshotId: "3".repeat(64),
        tasks: [taskA],
        aggregateLanes: duplicateAggregateLanes,
      }),
    },
    {
      name: "missing aggregate lane",
      snapshot: boardSnapshot({
        snapshotId: "4".repeat(64),
        tasks: [taskA],
        aggregateLanes: boardLanes([taskA]).slice(0, 4),
      }),
    },
    {
      name: "extra aggregate lane",
      snapshot: boardSnapshot({
        snapshotId: "5".repeat(64),
        tasks: [taskA],
        aggregateLanes: [
          ...boardLanes([taskA]),
          { id: "extra", label: "extra", description: "extra lane", tasks: [] },
        ],
      }),
    },
    {
      name: "unknown aggregate lane ID",
      snapshot: boardSnapshot({
        snapshotId: "6".repeat(64),
        tasks: [taskA],
        aggregateLanes: unknownAggregateLanes,
      }),
    },
    {
      name: "duplicate project lane ID",
      snapshot: boardSnapshot({
        snapshotId: "7".repeat(64),
        tasks: [taskA],
        projects: [boardProject("project-1", [taskA], duplicateProjectLanes)],
      }),
    },
    {
      name: "duplicate task ID inside one project",
      snapshot: boardSnapshot({
        snapshotId: "8".repeat(64),
        tasks: [taskA],
        projects: [boardProject("project-1", [taskA, { ...taskA }])],
      }),
    },
    {
      name: "duplicate task ID across projects",
      snapshot: boardSnapshot({
        snapshotId: "9".repeat(64),
        tasks: [taskA],
        projects: [
          boardProject("project-1", [taskA]),
          boardProject("project-2", [{ ...taskA, projectId: "project-2" }]),
        ],
      }),
    },
    {
      name: "duplicate project ID",
      snapshot: boardSnapshot({
        snapshotId: "a".repeat(64),
        tasks: [taskA, taskB],
        projects: [
          boardProject("duplicate-project", [taskA]),
          boardProject("duplicate-project", [taskB]),
        ],
      }),
    },
    {
      name: "project task set misses an aggregate task",
      snapshot: boardSnapshot({
        snapshotId: "b".repeat(64),
        tasks: [taskA, taskB],
        projects: [boardProject("project-1", [taskA])],
      }),
    },
    {
      name: "project task set adds a task absent from aggregate",
      snapshot: boardSnapshot({
        snapshotId: "c".repeat(64),
        tasks: [taskA],
        projects: [boardProject("project-1", [taskA, taskB])],
      }),
    },
    {
      name: "project task set replaces the aggregate task",
      snapshot: boardSnapshot({
        snapshotId: "d".repeat(64),
        tasks: [taskA],
        projects: [boardProject("project-1", [taskB])],
      }),
    },
  ];
}

async function runEmbeddedApplication(snapshot, { standalone = false, narrow = false } = {}) {
  const documentText = await buildEmbeddedBoardDocument(snapshot);
  const application = /<script data-projectboard-app>([\s\S]*?)<\/script>/u.exec(documentText);
  assert.ok(application, "composed document must contain the embedded application script");

  const elements = Object.fromEntries(appElementIds.map((id) => [id, new FakeElement()]));
  elements["fatal-error"].hidden = true;
  elements.workspace.hidden = true;
  elements["archive-toggle"].checked = true;
  const document = {
    querySelector(selector) {
      return selector.startsWith("#") ? elements[selector.slice(1)] ?? null : null;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };
  const mediaListeners = [];
  const media = {
    matches: narrow,
    addEventListener(type, listener) {
      if (type === "change") mediaListeners.push(listener);
    },
  };
  const globalListeners = new Map();
  const messages = [];
  const parent = {
    postMessage(message, targetOrigin) {
      messages.push({
        message: JSON.parse(JSON.stringify(message)),
        targetOrigin,
      });
    },
  };
  const context = createContext({
    __PROJECTBOARD_SNAPSHOT__: snapshot,
    document,
    location: { hash: "", pathname: "/board", search: "" },
    history: { replaceState() {} },
    matchMedia() {
      return media;
    },
    fetch() {
      throw new Error("embedded boot must not fetch");
    },
    addEventListener(type, listener) {
      const listeners = globalListeners.get(type) ?? [];
      listeners.push(listener);
      globalListeners.set(type, listeners);
    },
  });
  context.parent = standalone ? context : parent;
  runInContext(application[1], context, { filename: "composed-projectboard-app.js" });
  await new Promise((resolve) => setImmediate(resolve));

  return {
    elements,
    messages,
    dispatch(data) {
      const source = standalone ? context : parent;
      for (const listener of globalListeners.get("message") ?? []) listener({ data, source });
    },
    failNextLaneAppend(message = "render failed") {
      elements.lanes.appendError = new Error(message);
    },
  };
}

test("embedded board is one offline document with an escaped snapshot and a closed CSP", () => {
  const document = composeEmbeddedBoardDocument({
    mode: "standalone-readonly",
    projects: [{ id: "p1", name: "</script><script>globalThis.pwned=true</script>" }],
  }, {
    shell,
    styles: "body { color: CanvasText; }",
    script: "globalThis.boardBooted = true;",
  });

  assert.match(document, /只读 · Codex 侧栏/u);
  assert.match(document, /debugging pipe 显示只读快照/u);
  assert.match(document, /connect-src 'none'/u);
  assert.doesNotMatch(document, /frame-ancestors 'none'/u);
  assert.match(document, /data-projectboard-embedded/u);
  assert.match(document, /__PROJECTBOARD_SNAPSHOT__/u);
  assert.match(document, /\\u003c\/script\\u003e/u);
  assert.equal(document.includes("globalThis.pwned=true</script>"), false);
  assert.equal(document.includes('href="/app.css"'), false);
  assert.equal(document.includes('src="/app.js"'), false);
  assert.equal(document.includes("http://"), false);
  assert.equal(document.includes("https://"), false);
});

test("embedded board rejects ambiguous assets and non-readonly snapshots", () => {
  assert.throws(
    () => composeEmbeddedBoardDocument({ mode: "write", projects: [] }, { shell, styles: "x", script: "x" }),
    /read-only/u,
  );
  assert.throws(
    () => composeEmbeddedBoardDocument({ mode: "standalone-readonly", projects: [] }, {
      shell,
      styles: "</style>",
      script: "x",
    }),
    /unsafe/u,
  );
});

test("embedded application code runs after the board DOM exists", () => {
  const document = composeEmbeddedBoardDocument({
    mode: "standalone-readonly",
    projects: [{ id: "p1" }],
  }, {
    shell: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head><body><main id="workspace"></main><dialog id="task-dialog"></dialog></body></html>`,
    styles: "body { color: CanvasText; }",
    script: "globalThis.boardBooted = Boolean(document.querySelector('#workspace'));",
  });

  const workspace = document.indexOf('id="workspace"');
  const bootstrap = document.indexOf("globalThis.__PROJECTBOARD_SNAPSHOT__");
  const application = document.indexOf("globalThis.boardBooted");
  assert.ok(bootstrap > 0, "the immutable snapshot must be embedded");
  assert.ok(document.indexOf("data-projectboard-app") > document.indexOf('id="workspace"'));
  assert.ok(application > workspace, "application code must not run from the head before the workspace exists");
  assert.ok(application < document.indexOf("</body>"), "application code must remain inside the document body");
});

test("embedded UI gives the expanded workspace to five lanes and defaults to all history", async () => {
  const suppliedThreadIds = ["thread-quiet-ops-1", "thread-quiet-ops-2"];
  const document = await buildEmbeddedBoardDocument({
    mode: "standalone-readonly",
    generatedAt: "2026-08-11T00:00:00.000Z",
    source: { candidateVersion: "test", phase0RunId: "run" },
    summary: { projectCount: 1, taskCount: 2, activeThreadCount: 2, archivedThreadCount: 0, attentionCount: 0 },
    aggregate: {
      id: "all-history",
      name: "全部历史",
      workspace: "所有工作目录",
      counts: { total: 2, attention: 0, running: 0, archived: 0 },
      lanes: canonicalLaneIds.map((id) => ({
        id,
        label: id,
        description: `${id} lane`,
        tasks: id === "inbox"
          ? suppliedThreadIds.map((threadId) => ({ threadId }))
          : [],
      })),
    },
    projects: [],
  });

  assert.match(document, /id="project-select"/u);
  assert.match(document, /<option value="all-history">全部历史 · 2<\/option>/u);
  assert.match(document, /all-history/u);
  assert.match(document, /全部历史/u);
  for (const threadId of suppliedThreadIds) assert.match(document, new RegExp(threadId, "u"));
  assertQuietOpsDocument(document);
  assert.doesNotMatch(document, /turn\/start|thread\/(?:start|archive|delete)/u);
  assert.doesNotMatch(document, /https?:\/\/(?!127\.0\.0\.1(?::\d+)?(?:\/|["']))/u);
  assert.equal(document.includes("project-sidebar"), false);
  assert.equal(document.includes("max-width: 1439px"), false, "ordinary Codex workspace widths must retain five lanes");
  assert.match(document, /projectboard-readonly-ready/u);
  assert.match(document, /projectboard-readonly-applied/u);
  assert.match(document, /sourceTaskCount/u);
  assert.match(document, /renderedTaskCount/u);
  assert.match(document, /snapshotId/u);
  assert.match(document, /updateId/u);
  assert.match(document, /projectboard-readonly-stale/u);

  const mutedValues = [...document.matchAll(/--muted:\s*(#[0-9a-f]{6})/giu)]
    .map((match) => match[1].toLowerCase());
  const attentionValues = [...document.matchAll(/--attention-ink:\s*(#[0-9a-f]{6})/giu)]
    .map((match) => match[1].toLowerCase());
  assert.deepEqual(mutedValues, ["#5f6068", "#a1a1aa"]);
  assert.deepEqual(attentionValues, ["#9f1239", "#fda4af"]);
  for (const [foreground, background] of [
    [mutedValues[0], "#f7f7f8"],
    [mutedValues[0], "#ededf0"],
    [mutedValues[1], "#111113"],
    [mutedValues[1], "#222225"],
    [attentionValues[0], "#eff6ff"],
    [attentionValues[1], "#172554"],
  ]) {
    assert.ok(contrastRatio(foreground, background) >= 4.5,
      `${foreground} on ${background} must reach WCAG AA contrast`);
  }
});

test("embedded application renders Quiet Ops lane lists, empty guidance, and active task emphasis", async () => {
  const expectedEmptyMessages = new Map([
    ["inbox", "没有符合当前筛选的历史任务"],
    ["planned", "只读目录不会凭标题猜测计划状态"],
    ["running", "当前没有 Codex 正在执行的任务"],
    ["review", "等待未来经过安全门槛的明确状态"],
    ["done", "历史对话仍可在收集箱中完整检索"],
  ]);
  const emptyBoard = await runEmbeddedApplication(boardSnapshot({ tasks: [] }));

  for (const lane of emptyBoard.elements.lanes.children) {
    assert.equal(lane.children[1].className, "lane-list");
    const emptyStates = descendants(lane).filter(({ className }) => className === "empty-lane");
    assert.equal(emptyStates.length, 1);
    assert.equal(emptyStates[0].textContent, expectedEmptyMessages.get(lane.dataset.lane));
  }

  const activeTask = { ...boardTask("active-task", "Active task"), sourceStatus: "active" };
  const activeBoard = await runEmbeddedApplication(boardSnapshot({ tasks: [activeTask] }));
  const listItem = descendants(activeBoard.elements.lanes)
    .find(({ attributes }) => attributes.get("role") === "listitem");
  assert.ok(listItem);
  assert.equal(listItem.tagName, "ARTICLE");
  assert.equal(listItem.className, "");
  assert.equal(listItem.children.length, 1);
  const card = listItem.children[0];
  assert.equal(card.tagName, "BUTTON");
  assert.equal(card.type, "button");
  assert.equal(card.className, "task-card");
  assert.equal(card.attributes.has("role"), false);
  assert.equal(card.listeners.has("keydown"), false);
  assert.deepEqual(card.children.map(({ tagName }) => tagName), ["SPAN", "SPAN", "SPAN"],
    "native button content must remain valid phrasing content");
  assert.equal(card.dataset.active, "true");
  assert.match(elementText(card), /活动中/u);
  assert.match(card.attributes.get("aria-label"), /活动中/u);
  assert.ok(descendants(card).some(({ className, textContent }) => (
    className === "task-badge active" && textContent === "活动中"
  )));
  assert.notEqual(activeBoard.elements["task-dialog"].open, true);
  card.click();
  assert.equal(activeBoard.elements["task-dialog"].open, true);
});

test("mobile lane controls use pressed-button semantics and retain focus after selection", async () => {
  const board = await runEmbeddedApplication(boardSnapshot(), { narrow: true });
  const initialButtons = board.elements["lane-tabs"].children;

  for (const button of initialButtons) {
    assert.equal(button.attributes.has("role"), false);
    assert.equal(button.attributes.get("aria-pressed"), String(button.dataset.lane === "inbox"));
  }

  const runningButton = initialButtons.find(({ dataset }) => dataset.lane === "running");
  assert.ok(runningButton);
  runningButton.click();

  const refreshedButtons = board.elements["lane-tabs"].children;
  const selectedButton = refreshedButtons.find(({ dataset }) => dataset.lane === "running");
  assert.equal(selectedButton.attributes.get("aria-pressed"), "true");
  assert.equal(selectedButton.focused, true);
  assert.equal(board.elements.lanes.querySelector('[data-lane="running"]').hidden, false);
});

test("embedded application boots with one exact ready receipt and stays silent standalone", async () => {
  const snapshot = boardSnapshot();
  const embedded = await runEmbeddedApplication(snapshot);

  assert.deepEqual(embedded.messages, [{
    message: {
      type: "projectboard-readonly-ready",
      snapshotId: snapshot.snapshotId,
      sourceTaskCount: 1,
      renderedTaskCount: 1,
    },
    targetOrigin: "*",
  }]);
  assert.equal(embedded.elements.workspace.hidden, false);
  assert.equal(embedded.elements["fatal-error"].hidden, true);
  assert.equal(embedded.elements.lanes.children.length, 5);

  const standalone = await runEmbeddedApplication(snapshot, { standalone: true });
  assert.deepEqual(standalone.messages, []);
  assert.equal(standalone.elements.workspace.hidden, false);
});

test("embedded application applies a valid update with the matching receipt", async () => {
  const initial = boardSnapshot();
  const next = boardSnapshot({
    snapshotId: "b".repeat(64),
    generatedAt: "2026-08-11T00:01:00.000Z",
    tasks: [boardTask("task-2", "Updated task")],
  });
  const embedded = await runEmbeddedApplication(initial);

  embedded.dispatch({
    type: "projectboard-readonly-snapshot",
    updateId: "update-1",
    snapshot: next,
  });

  assert.deepEqual(embedded.messages.at(-1), {
    message: {
      type: "projectboard-readonly-applied",
      updateId: "update-1",
      snapshotId: next.snapshotId,
      sourceTaskCount: 1,
      renderedTaskCount: 1,
    },
    targetOrigin: "*",
  });
  assert.match(elementText(embedded.elements.lanes), /Updated task/u);
});

test("malformed lane and task-set topologies emit no ready receipt", async (t) => {
  for (const { name, snapshot } of invalidTopologySnapshots()) {
    await t.test(name, async () => {
      const embedded = await runEmbeddedApplication(snapshot);
      assert.deepEqual(embedded.messages, []);
      assert.equal(embedded.elements.workspace.hidden, true);
    });
  }
});

test("malformed lane and task-set updates preserve the last good board", async (t) => {
  for (const { name, snapshot } of invalidTopologySnapshots()) {
    await t.test(name, async () => {
      const embedded = await runEmbeddedApplication(boardSnapshot());
      embedded.dispatch({
        type: "projectboard-readonly-snapshot",
        updateId: `invalid-${name}`,
        snapshot,
      });

      assert.equal(embedded.messages.length, 1, "invalid update must not emit applied");
      assert.equal(embedded.elements.workspace.hidden, false);
      assert.match(elementText(embedded.elements.lanes), /Initial task/u);
      assert.match(embedded.elements["sync-status"].textContent, /数据已过期/u);
    });
  }
});

test("invalid updates keep the last rendered snapshot stale and emit no applied receipt", async () => {
  const initial = boardSnapshot();
  const embedded = await runEmbeddedApplication(initial);
  const invalidProject = {
    id: "project-1",
    name: "Project",
    workspace: "C:\\project",
    counts: { total: 1 },
    lanes: boardLanes([{}]),
  };
  const invalidUpdates = [
    {},
    boardSnapshot({ snapshotId: "not-a-64-hex-snapshot-id" }),
    boardSnapshot({ snapshotId: "b".repeat(64), tasks: [{}], taskCount: 1, total: 1 }),
    boardSnapshot({ snapshotId: "c".repeat(64), tasks: [boardTask("")], taskCount: 1, total: 1 }),
    boardSnapshot({
      snapshotId: "d".repeat(64),
      tasks: [boardTask("duplicate"), boardTask("duplicate")],
      taskCount: 2,
      total: 2,
    }),
    boardSnapshot({ snapshotId: "e".repeat(64), taskCount: 2, total: 1 }),
    boardSnapshot({
      snapshotId: "f".repeat(64),
      projects: [invalidProject],
    }),
    boardSnapshot({
      snapshotId: "1".repeat(64),
      aggregateLanes: [{ id: "inbox", label: "Inbox", description: "", tasks: {} }],
      taskCount: 0,
      total: 0,
    }),
  ];

  invalidUpdates.forEach((snapshot, index) => embedded.dispatch({
    type: "projectboard-readonly-snapshot",
    updateId: `invalid-${index}`,
    snapshot,
  }));

  assert.equal(embedded.messages.length, 1, "invalid updates must not be acknowledged");
  assert.equal(embedded.elements.workspace.hidden, false, "the last good board must stay visible");
  assert.match(elementText(embedded.elements.lanes), /Initial task/u);
  assert.match(embedded.elements["sync-status"].textContent, /数据已过期/u);
  assert.equal(embedded.elements["fatal-error"].hidden, false);

  const recovered = boardSnapshot({
    snapshotId: "2".repeat(64),
    generatedAt: "2026-08-11T00:02:00.000Z",
    tasks: [boardTask("task-2", "Recovered task")],
  });
  embedded.dispatch({
    type: "projectboard-readonly-snapshot",
    updateId: "recovered",
    snapshot: recovered,
  });

  assert.equal(embedded.messages.length, 2);
  assert.equal(embedded.messages.at(-1).message.type, "projectboard-readonly-applied");
  assert.doesNotMatch(embedded.elements["sync-status"].textContent, /数据已过期/u);
  assert.equal(embedded.elements["fatal-error"].hidden, true);
  assert.equal(embedded.elements["fatal-error"].textContent, "");
  assert.equal(embedded.elements.workspace.hidden, false);
  assert.match(elementText(embedded.elements.lanes), /Recovered task/u);
});

test("stale messages bind exactly to the currently rendered snapshot", async () => {
  const initial = boardSnapshot();
  const embedded = await runEmbeddedApplication(initial);
  const normalStatus = embedded.elements["sync-status"].textContent;

  embedded.dispatch({ type: "projectboard-readonly-stale" });
  embedded.dispatch({ type: "projectboard-readonly-stale", snapshotId: "short" });
  embedded.dispatch({ type: "projectboard-readonly-stale", snapshotId: "b".repeat(64) });
  assert.equal(embedded.elements["sync-status"].textContent, normalStatus);

  embedded.dispatch({ type: "projectboard-readonly-stale", snapshotId: initial.snapshotId });
  assert.match(embedded.elements["sync-status"].textContent, /数据已过期/u);

  const next = boardSnapshot({
    snapshotId: "b".repeat(64),
    generatedAt: "2026-08-11T00:03:00.000Z",
    tasks: [boardTask("task-2", "Current task")],
  });
  embedded.dispatch({
    type: "projectboard-readonly-snapshot",
    updateId: "current",
    snapshot: next,
  });
  const refreshedStatus = embedded.elements["sync-status"].textContent;
  assert.doesNotMatch(refreshedStatus, /数据已过期/u);

  embedded.dispatch({ type: "projectboard-readonly-stale", snapshotId: initial.snapshotId });
  assert.equal(embedded.elements["sync-status"].textContent, refreshedStatus);
  embedded.dispatch({ type: "projectboard-readonly-stale", snapshotId: next.snapshotId });
  assert.match(embedded.elements["sync-status"].textContent, /数据已过期/u);
});

test("a render failure rolls state and DOM back to the last good snapshot", async () => {
  const initial = boardSnapshot();
  const embedded = await runEmbeddedApplication(initial);
  const next = boardSnapshot({
    snapshotId: "b".repeat(64),
    tasks: [boardTask("task-2", "Must not replace old view")],
  });
  embedded.failNextLaneAppend();

  embedded.dispatch({
    type: "projectboard-readonly-snapshot",
    updateId: "render-failure",
    snapshot: next,
  });

  assert.equal(embedded.messages.length, 1);
  assert.equal(embedded.elements.workspace.hidden, false);
  assert.match(elementText(embedded.elements.lanes), /Initial task/u);
  assert.doesNotMatch(elementText(embedded.elements.lanes), /Must not replace old view/u);
  assert.match(embedded.elements["sync-status"].textContent, /数据已过期/u);
});
