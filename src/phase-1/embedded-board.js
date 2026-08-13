import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const UI_ASSETS = Object.freeze({
  shell: fileURLToPath(new URL("./ui/index.html", import.meta.url)),
  styles: fileURLToPath(new URL("./ui/app.css", import.meta.url)),
  script: fileURLToPath(new URL("./ui/app.js", import.meta.url)),
});
const STYLE_LINK = '<link rel="stylesheet" href="/app.css">';
const SCRIPT_TAG = '<script src="/app.js" defer></script>';
const EMBEDDED_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const STATIC_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const CANONICAL_LANES = Object.freeze(["inbox", "planned", "running", "review", "done"]);
const EMPTY_LANES = Object.freeze({
  inbox: "没有历史任务",
  planned: "只读目录不会凭标题猜测计划状态",
  running: "当前没有 Codex 正在执行的任务",
  review: "等待未来经过安全门槛的明确状态",
  done: "历史对话仍可在收集箱中完整检索",
});
function safeSnapshotJson(snapshot) {
  return JSON.stringify(snapshot)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function validateAssets({ shell, styles, script }) {
  if (![shell, styles, script].every((value) => typeof value === "string" && value.length > 0)) {
    throw new TypeError("embedded board assets must be nonempty strings");
  }
  if (!shell.includes(STYLE_LINK) || !shell.includes(SCRIPT_TAG)) {
    throw new Error("embedded board shell does not contain the expected local asset tags");
  }
  if (!shell.includes("</body>")) {
    throw new Error("embedded board shell does not contain a body boundary");
  }
  if (/<\/style/iu.test(styles) || /<\/script/iu.test(script)) {
    throw new Error("embedded board assets contain an unsafe raw-text closing tag");
  }
}

function escapeMarkup(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function staticSnapshotTasks(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || snapshot.mode !== "standalone-readonly"
    || typeof snapshot.snapshotId !== "string"
    || !/^[0-9a-f]{64}$/u.test(snapshot.snapshotId)
    || !Number.isSafeInteger(snapshot.summary?.projectCount)
    || snapshot.summary.projectCount < 0
    || !Number.isSafeInteger(snapshot.summary?.taskCount)
    || snapshot.summary.taskCount < 0
    || !Array.isArray(snapshot.projects)
    || snapshot.projects.length !== snapshot.summary.projectCount
    || !snapshot.aggregate
    || snapshot.aggregate.id !== "all-history"
    || !Array.isArray(snapshot.aggregate.lanes)
    || snapshot.aggregate.lanes.length !== CANONICAL_LANES.length) {
    throw new TypeError("a canonical standalone read-only board snapshot is required");
  }
  const laneIds = snapshot.aggregate.lanes.map(({ id } = {}) => id);
  if (new Set(laneIds).size !== CANONICAL_LANES.length
    || CANONICAL_LANES.some((id) => !laneIds.includes(id))) {
    throw new TypeError("the static board requires the canonical five lanes");
  }
  const tasks = snapshot.aggregate.lanes.flatMap(({ tasks }) => {
    if (!Array.isArray(tasks)) throw new TypeError("each static board lane must contain a task array");
    return tasks;
  });
  const taskIds = tasks.map(({ id } = {}) => id);
  if (taskIds.length !== snapshot.summary.taskCount
    || taskIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(taskIds).size !== taskIds.length) {
    throw new TypeError("the static board task identity set must match the snapshot summary");
  }
  return tasks;
}

function staticTimestamp(value) {
  const numeric = typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function staticBadge(label, className = "") {
  return `<span class="task-badge${className ? ` ${className}` : ""}">${escapeMarkup(label)}</span>`;
}

function staticTaskCard(task, projects, lanes) {
  const project = projects.get(task.projectId);
  const active = task.sourceStatus === "active";
  const badges = [
    project ? staticBadge(project.name, "project") : "",
    active ? staticBadge("活动中", "active") : "",
    task.attention ? staticBadge(task.attention.label, "attention") : "",
    task.archived ? staticBadge("导入归档", "archived") : "",
    staticBadge(staticTimestamp(task.updatedAt)),
  ].join("");
  const threadHref = `#projectboard-open/${encodeURIComponent(task.threadId)}`;
  const moveLinks = lanes
    .filter(({ id }) => id !== task.state)
    .map(({ id, label }) => `<label class="task-move-option"><input type="radio" name="projectboard-move-request" data-projectboard-move-thread="${escapeMarkup(task.threadId)}" data-projectboard-move-lane="${escapeMarkup(id)}" aria-label="${escapeMarkup(`把${task.title}移动到${label}`)}"><span>${escapeMarkup(label)}</span></label>`)
    .join("");
  return `<article role="listitem" class="task-card" data-projectboard-task-id="${escapeMarkup(task.id)}" data-projectboard-thread-id="${escapeMarkup(task.threadId)}" data-projectboard-current-lane="${escapeMarkup(task.state)}"${active ? ' data-active="true"' : ""}>
    <a class="task-open-link" draggable="false" href="${escapeMarkup(threadHref)}" title="打开原 Codex 任务" aria-label="${escapeMarkup(`在 Codex 中打开：${task.title}`)}">
      <span class="task-card-title">${escapeMarkup(task.title)}</span>
      <span class="task-next">${escapeMarkup(task.nextAction)}</span>
      <span class="task-meta">${badges}</span>
    </a>
    <details class="task-move-menu"><summary>移动到其他栏</summary><div class="task-move-links" role="group" aria-label="${escapeMarkup(`移动任务：${task.title}`)}">${moveLinks}</div></details>
  </article>`;
}

export function composeStaticEmbeddedBoardDocument(snapshot, { styles }) {
  if (typeof styles !== "string" || styles.length === 0 || /<\/style/iu.test(styles)) {
    throw new TypeError("static embedded board styles must be a safe nonempty string");
  }
  const tasks = staticSnapshotTasks(snapshot);
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const attentionTasks = tasks.filter(({ attention }) => attention);
  const attention = attentionTasks.length === 0
    ? '<span class="attention-empty">当前没有可由线程元数据确认的注意项</span>'
    : attentionTasks.map((task) => `<span class="attention-item"><strong>${escapeMarkup(task.attention.label)}</strong><span>${escapeMarkup(task.title)}</span></span>`).join("");
  const lanes = snapshot.aggregate.lanes.map((lane, index) => {
    const cards = lane.tasks.length === 0
      ? `<p class="empty-lane">${escapeMarkup(EMPTY_LANES[lane.id])}</p>`
      : lane.tasks.map((task) => staticTaskCard(task, projects, snapshot.aggregate.lanes)).join("");
    return `<section class="lane" data-projectboard-lane="${escapeMarkup(lane.id)}" aria-label="${escapeMarkup(`${snapshot.aggregate.name}，第 ${index + 1}/5 列，${lane.label}`)}">
      <div class="lane-heading"><div><h3>${escapeMarkup(lane.label)}</h3><p>${escapeMarkup(lane.description)}</p></div><span class="count-badge">${lane.tasks.length}</span></div>
      <div class="lane-list" role="list">${cards}</div>
    </section>`;
  }).join("");
  const archivedCount = Number.isSafeInteger(snapshot.summary.archivedThreadCount)
    ? snapshot.summary.archivedThreadCount
    : 0;
  return `<!doctype html>
<html lang="zh-CN" data-projectboard-static="true" data-projectboard-mode="standalone-readonly" data-projectboard-snapshot-id="${escapeMarkup(snapshot.snapshotId)}" data-projectboard-rendered-task-count="${tasks.length}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="content-security-policy" content="${STATIC_CSP}">
  <title>Codex Projectboard</title>
  <style data-projectboard-embedded>${styles}</style>
</head>
<body data-visual-direction="quiet-ops">
  <main class="workspace">
    <section class="board-shell" aria-labelledby="project-title">
      <header class="app-bar">
        <div class="title-block"><span class="brand-mark" aria-hidden="true"></span><div><h1>任务面板</h1><p id="catalog-summary">${snapshot.summary.projectCount} 个项目 · ${tasks.length} 个历史任务 · ${archivedCount} 个已归档</p></div></div>
        <div class="toolbar"><span class="archive-filter">Codex 只读 · 本地编排</span></div>
      </header>
      <div class="context-row"><div><h2 id="project-title">全部历史</h2><p id="project-path">所有工作目录</p></div><p id="sync-status">快照 ${escapeMarkup(staticTimestamp(snapshot.generatedAt))}</p></div>
      <section class="attention-rail" aria-labelledby="attention-title"><h3 id="attention-title">需要我处理 <span id="attention-total">${attentionTasks.length}</span></h3><div class="attention-list">${attention}</div></section>
      <nav class="lane-tabs" aria-label="任务状态"></nav>
      <div class="board-grid" aria-label="五栏任务看板">${lanes}</div>
    </section>
  </main>
</body>
</html>`;
}

export function composeEmbeddedBoardDocument(snapshot, assets) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.mode !== "standalone-readonly" || !Array.isArray(snapshot.projects)) {
    throw new TypeError("a standalone read-only board snapshot is required");
  }
  validateAssets(assets);
  const csp = `<meta http-equiv="content-security-policy" content="${EMBEDDED_CSP}">`;
  const bootstrap = `<script>globalThis.__PROJECTBOARD_SNAPSHOT__=${safeSnapshotJson(snapshot)};</script>`;
  const taskCount = Number.isSafeInteger(snapshot.summary?.taskCount) && snapshot.summary.taskCount >= 0
    ? snapshot.summary.taskCount
    : 0;
  return assets.shell
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  ${csp}`)
    .replace(STYLE_LINK, `<style data-projectboard-embedded>${assets.styles}</style>`)
    .replace(SCRIPT_TAG, bootstrap)
    .replace("</body>", `  <script data-projectboard-app>${assets.script}</script>\n</body>`)
    .replace("全部历史 · 0", `全部历史 · ${taskCount}`)
    .replace("只读 · 独立窗口", "只读 · Codex 侧栏")
    .replace(
      "Phase 1 降级边界：仅浏览线程元数据；不注入 Codex，不创建 turn，不改变任务状态，不写 Git。",
      "Phase 1 安全边界：通过受控 debugging pipe 显示只读快照；不创建 turn，不改变任务状态，不写 Git。",
    );
}

export async function buildEmbeddedBoardDocument(snapshot, { read = readFile } = {}) {
  if (typeof read !== "function") throw new TypeError("read must be a function");
  const [shell, styles, script] = await Promise.all(
    Object.values(UI_ASSETS).map((assetPath) => read(assetPath, "utf8")),
  );
  return composeEmbeddedBoardDocument(snapshot, { shell, styles, script });
}

export async function buildStaticEmbeddedBoardDocument(snapshot, { read = readFile } = {}) {
  if (typeof read !== "function") throw new TypeError("read must be a function");
  const styles = await read(UI_ASSETS.styles, "utf8");
  return composeStaticEmbeddedBoardDocument(snapshot, { styles });
}
