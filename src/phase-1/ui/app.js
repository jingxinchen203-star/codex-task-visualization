const laneLabels = new Map([
  ["inbox", "收集箱"],
  ["planned", "已规划"],
  ["running", "执行中"],
  ["review", "待验收"],
  ["done", "完成"],
]);
const emptyMessages = new Map([
  ["inbox", "这里很轻，试试调整筛选或搜索"],
  ["planned", "暂无已规划任务，可以从收集箱整理"],
  ["running", "当前没有正在推进的任务"],
  ["review", "成果就绪后会在这里等待确认"],
  ["done", "完成的任务会在这里留下记录"],
]);
const canonicalLaneIds = new Set(laneLabels.keys());
const sourceLabels = new Map([
  ["notLoaded", "未同步"],
  ["idle", "空闲"],
  ["systemError", "需要检查"],
  ["active", "正在推进"],
]);

const elements = {
  workspace: document.querySelector("#workspace"),
  fatalError: document.querySelector("#fatal-error"),
  syncStatus: document.querySelector("#sync-status"),
  catalogSummary: document.querySelector("#catalog-summary"),
  projectSelect: document.querySelector("#project-select"),
  projectTitle: document.querySelector("#project-title"),
  projectPath: document.querySelector("#project-path"),
  search: document.querySelector("#search-input"),
  archiveToggle: document.querySelector("#archive-toggle"),
  attentionTotal: document.querySelector("#attention-total"),
  attentionList: document.querySelector("#attention-list"),
  laneTabs: document.querySelector("#lane-tabs"),
  lanes: document.querySelector("#lanes"),
  dialog: document.querySelector("#task-dialog"),
  dialogClose: document.querySelector("#dialog-close"),
  dialogKicker: document.querySelector("#dialog-kicker"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogAttention: document.querySelector("#dialog-attention"),
  dialogNextAction: document.querySelector("#dialog-next-action"),
  dialogState: document.querySelector("#dialog-state"),
  dialogSourceStatus: document.querySelector("#dialog-source-status"),
  dialogUpdated: document.querySelector("#dialog-updated"),
  dialogArchive: document.querySelector("#dialog-archive"),
  dialogThreadId: document.querySelector("#dialog-thread-id"),
};

const state = {
  snapshot: null,
  projectId: null,
  laneId: "inbox",
  query: "",
  showArchived: true,
  stale: false,
};
const narrowLayout = matchMedia("(max-width: 699px)");

function text(element, value) {
  element.textContent = value ?? "";
}

function formatDate(timestamp) {
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const snapshotDate = new Date(state.snapshot?.generatedAt ?? Date.now());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const startOfSnapshot = new Date(snapshotDate.getFullYear(), snapshotDate.getMonth(), snapshotDate.getDate()).getTime();
  const dayDifference = Math.round((startOfSnapshot - startOfDate) / 86_400_000);
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (dayDifference === 0) return `今天 ${time}`;
  if (dayDifference === 1) return `昨天 ${time}`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function formatFullDate(timestamp) {
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function selectedProject() {
  if (!state.snapshot) return null;
  if (state.projectId === state.snapshot.aggregate?.id) return state.snapshot.aggregate;
  return state.snapshot.projects.find(({ id }) => id === state.projectId) ?? state.snapshot.aggregate ?? null;
}

function allTasks(project) {
  return project?.lanes.flatMap(({ tasks }) => tasks) ?? [];
}

function visibleTasks(tasks) {
  const query = state.query.toLocaleLowerCase("zh-CN");
  return tasks.filter((task) => {
    if (!state.showArchived && task.archived) return false;
    if (!query) return true;
    const origin = sourceProject(task);
    return `${task.title} ${task.nextAction} ${task.threadId} ${origin?.name ?? ""} ${origin?.workspace ?? ""}`
      .toLocaleLowerCase("zh-CN")
      .includes(query);
  });
}

function badge(label, className = "", titleValue = "") {
  const value = document.createElement("span");
  value.className = `task-badge ${className}`.trim();
  text(value, label);
  if (titleValue) value.setAttribute("title", titleValue);
  return value;
}

function sourceProject(task) {
  return state.snapshot?.projects.find(({ id }) => id === task.projectId) ?? null;
}

function showTask(project, task) {
  const origin = sourceProject(task) ?? project;
  text(elements.dialogKicker, `${origin.name} · ${laneLabels.get(task.state) ?? task.state}`);
  text(elements.dialogTitle, task.title);
  elements.dialogAttention.hidden = !task.attention;
  text(elements.dialogAttention, task.attention?.label);
  text(elements.dialogNextAction, task.nextAction);
  text(elements.dialogState, laneLabels.get(task.state) ?? task.state);
  text(elements.dialogSourceStatus, sourceLabels.get(task.sourceStatus) ?? task.sourceStatus);
  text(elements.dialogUpdated, formatDate(task.updatedAt));
  text(elements.dialogArchive, task.archived ? "从 Codex 归档导入" : "当前 Codex 列表");
  text(elements.dialogThreadId, task.threadId);
  elements.dialog.showModal();
}

function renderProjectOptions() {
  elements.projectSelect.replaceChildren();
  const projects = [state.snapshot.aggregate, ...state.snapshot.projects].filter(Boolean);
  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.selected = project.id === state.projectId;
    text(option, `${project.name} · ${project.counts.total}`);
    elements.projectSelect.append(option);
  }
}

function renderAttention(project) {
  elements.attentionList.replaceChildren();
  const tasks = visibleTasks(allTasks(project)).filter(({ attention }) => attention);
  text(elements.attentionTotal, String(tasks.length));
  if (tasks.length === 0) {
    const empty = document.createElement("span");
    empty.className = "attention-empty";
    text(empty, "现在没有需要你接手的任务");
    elements.attentionList.append(empty);
    return;
  }
  for (const task of tasks) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "attention-item";
    const reason = document.createElement("strong");
    text(reason, task.attention.label);
    const title = document.createElement("span");
    text(title, task.title);
    item.append(reason, title);
    item.addEventListener("click", () => showTask(project, task));
    elements.attentionList.append(item);
  }
}

function renderLaneTabs(project) {
  elements.laneTabs.replaceChildren();
  for (const lane of project.lanes) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "lane-tab";
    tab.dataset.lane = lane.id;
    tab.setAttribute("aria-pressed", String(lane.id === state.laneId));
    text(tab, `${lane.label} ${visibleTasks(lane.tasks).length}`);
    tab.addEventListener("click", () => {
      state.laneId = lane.id;
      renderLaneTabs(project);
      applyLaneVisibility();
      elements.laneTabs.querySelector(`[data-lane="${lane.id}"]`)?.focus();
    });
    elements.laneTabs.append(tab);
  }
}

function taskCard(project, task) {
  const item = document.createElement("article");
  item.setAttribute("role", "listitem");
  const card = document.createElement("button");
  card.type = "button";
  card.className = "task-card";
  const active = task.sourceStatus === "active";
  if (active) card.dataset.active = "true";
  card.dataset.state = task.state;
  card.setAttribute("aria-label", `${task.title}，${laneLabels.get(task.state)}${active ? "，正在推进" : ""}${task.attention ? `，${task.attention.label}` : ""}`);
  const title = document.createElement("span");
  title.className = "task-card-title";
  text(title, task.title);
  const next = document.createElement("span");
  next.className = "task-next";
  text(next, task.nextAction);
  const meta = document.createElement("span");
  meta.className = "task-meta";
  if (active) meta.append(badge("进行中", "active"));
  if (task.attention) meta.append(badge(task.attention.label, "attention"));
  if (project.id === state.snapshot.aggregate?.id) {
    const origin = sourceProject(task);
    if (origin) meta.append(badge(origin.name, "project"));
  }
  if (task.archived) meta.append(badge("已归档", "archived"));
  meta.append(badge(formatDate(task.updatedAt), "time", formatFullDate(task.updatedAt)));
  card.append(title, next, meta);
  card.addEventListener("click", () => showTask(project, task));
  item.append(card);
  return item;
}

function renderLanes(project) {
  elements.lanes.replaceChildren();
  for (const lane of project.lanes) {
    const region = document.createElement("section");
    region.className = "lane";
    region.dataset.lane = lane.id;
    region.tabIndex = -1;
    region.setAttribute("aria-label", `${project.name}，第 ${project.lanes.indexOf(lane) + 1}/5 列，${lane.label}`);
    const heading = document.createElement("div");
    heading.className = "lane-heading";
    heading.dataset.lane = lane.id;
    const label = document.createElement("div");
    const title = document.createElement("h3");
    text(title, lane.label);
    const description = document.createElement("p");
    text(description, lane.description);
    label.append(title, description);
    const tasks = visibleTasks(lane.tasks);
    const count = document.createElement("span");
    count.className = "count-badge";
    text(count, String(tasks.length));
    heading.append(label, count);
    const list = document.createElement("div");
    list.className = "lane-list";
    list.setAttribute("role", "list");
    if (tasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-lane";
      text(empty, emptyMessages.get(lane.id));
      list.append(empty);
    } else {
      for (const task of tasks) list.append(taskCard(project, task));
    }
    region.append(heading, list);
    elements.lanes.append(region);
  }
  applyLaneVisibility();
}

function applyLaneVisibility() {
  for (const lane of elements.lanes.querySelectorAll(".lane")) {
    lane.hidden = narrowLayout.matches && lane.dataset.lane !== state.laneId;
  }
}

function render() {
  const project = selectedProject();
  renderProjectOptions();
  if (!project) {
    text(elements.projectTitle, "没有可显示的工作目录");
    text(elements.projectPath, "App Server 返回了空线程目录；看板未创建任何占位任务。");
    renderAttention(null);
    elements.laneTabs.replaceChildren();
    elements.lanes.replaceChildren();
    return;
  }
  state.projectId = project.id;
  const aggregateSelected = project.id === state.snapshot.aggregate?.id;
  text(elements.projectTitle, aggregateSelected ? "全部任务" : project.name);
  text(elements.projectPath, aggregateSelected ? "跨项目工作视图" : project.workspace);
  renderAttention(project);
  renderLaneTabs(project);
  renderLanes(project);
}

function fail(message) {
  elements.fatalError.hidden = false;
  text(elements.fatalError, message);
  elements.workspace.hidden = true;
  text(elements.syncStatus, "本地快照暂不可用");
  elements.syncStatus.dataset.stale = "true";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSnapshotId(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function tasksInLanes(lanes) {
  if (!Array.isArray(lanes) || lanes.length !== canonicalLaneIds.size) {
    throw new Error("看板栏结构无效");
  }
  const tasks = [];
  const laneIds = new Set();
  for (const lane of lanes) {
    if (!isRecord(lane)
      || typeof lane.id !== "string"
      || lane.id.trim().length === 0
      || !canonicalLaneIds.has(lane.id)
      || laneIds.has(lane.id)
      || !Array.isArray(lane.tasks)) {
      throw new Error("看板栏结构无效");
    }
    laneIds.add(lane.id);
    for (const task of lane.tasks) {
      if (!isRecord(task) || typeof task.id !== "string" || task.id.trim().length === 0) {
        throw new Error("看板任务标识无效");
      }
      tasks.push(task);
    }
  }
  return tasks;
}

function receiptFor(snapshot) {
  if (!isRecord(snapshot)
    || snapshot.mode !== "standalone-readonly"
    || !isRecord(snapshot.summary)
    || !isCount(snapshot.summary.projectCount)
    || !isCount(snapshot.summary.taskCount)
    || !isCount(snapshot.summary.archivedThreadCount)
    || !isRecord(snapshot.aggregate)
    || snapshot.aggregate.id !== "all-history"
    || !isRecord(snapshot.aggregate.counts)
    || !isCount(snapshot.aggregate.counts.total)
    || !Array.isArray(snapshot.projects)
    || snapshot.projects.length !== snapshot.summary.projectCount) {
    throw new Error("看板快照格式无效");
  }
  if (!isSnapshotId(snapshot.snapshotId)) {
    throw new Error("看板快照标识无效");
  }
  const tasks = tasksInLanes(snapshot.aggregate.lanes);
  const ids = new Set(tasks.map(({ id }) => id));
  if (ids.size !== tasks.length
    || ids.size !== snapshot.summary.taskCount
    || ids.size !== snapshot.aggregate.counts.total) {
    throw new Error("看板任务数量不一致");
  }
  const projectIds = new Set();
  const projectTaskIds = new Set();
  for (const project of snapshot.projects) {
    if (!isRecord(project)
      || typeof project.id !== "string"
      || project.id.trim().length === 0
      || projectIds.has(project.id)
      || !isRecord(project.counts)
      || !isCount(project.counts.total)) {
      throw new Error("看板项目结构无效");
    }
    projectIds.add(project.id);
    const projectTasks = tasksInLanes(project.lanes);
    const currentProjectTaskIds = new Set(projectTasks.map(({ id }) => id));
    if (currentProjectTaskIds.size !== projectTasks.length
      || projectTasks.length !== project.counts.total) {
      throw new Error("看板项目任务数量不一致");
    }
    for (const id of currentProjectTaskIds) {
      if (projectTaskIds.has(id)) throw new Error("看板项目任务重复");
      projectTaskIds.add(id);
    }
  }
  if (projectTaskIds.size !== ids.size
    || [...ids].some((id) => !projectTaskIds.has(id))) {
    throw new Error("看板项目任务与汇总不一致");
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

function renderSyncStatus() {
  const timestamp = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(state.snapshot.generatedAt));
  elements.syncStatus.dataset.stale = String(state.stale);
  text(elements.syncStatus, state.stale
    ? `已保留上次结果 · ${timestamp}`
    : `已同步 ${timestamp}`);
}

function renderSnapshot() {
  renderSyncStatus();
  text(elements.catalogSummary, `${state.snapshot.summary.projectCount} 个项目 · ${state.snapshot.summary.taskCount} 个任务 · ${state.snapshot.summary.archivedThreadCount} 个归档`);
  elements.workspace.hidden = false;
  render();
}

function applySnapshot(snapshot) {
  const receipt = receiptFor(snapshot);
  const previous = {
    snapshot: state.snapshot,
    projectId: state.projectId,
    laneId: state.laneId,
    stale: state.stale,
  };
  try {
    state.snapshot = snapshot;
    state.stale = false;
    state.projectId = (previous.projectId === snapshot.aggregate.id
      || snapshot.projects.some(({ id }) => id === previous.projectId))
      ? previous.projectId
      : snapshot.aggregate.id;
    renderSnapshot();
    elements.fatalError.hidden = true;
    text(elements.fatalError, "");
    return receipt;
  } catch (error) {
    state.snapshot = previous.snapshot;
    state.projectId = previous.projectId;
    state.laneId = previous.laneId;
    state.stale = previous.stale;
    if (state.snapshot) {
      try {
        renderSnapshot();
      } catch {
        // Best effort: the caller will preserve the last known state and surface the error.
      }
    }
    throw error;
  }
}

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

elements.search.addEventListener("input", () => {
  state.query = elements.search.value.trim();
  render();
});
elements.search.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || elements.search.value.length === 0) return;
  event.preventDefault();
  elements.search.value = "";
  state.query = "";
  render();
});
elements.projectSelect.addEventListener("change", () => {
  state.projectId = elements.projectSelect.value;
  const project = selectedProject();
  state.laneId = project?.lanes.find(({ tasks }) => visibleTasks(tasks).length > 0)?.id ?? "inbox";
  render();
  elements.projectTitle.focus?.();
});
elements.archiveToggle.addEventListener("change", () => {
  state.showArchived = elements.archiveToggle.checked;
  render();
});
elements.dialogClose.addEventListener("click", () => elements.dialog.close());
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) elements.dialog.close();
});
narrowLayout.addEventListener("change", applyLaneVisibility);
globalThis.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase("en-US") !== "k") return;
  event.preventDefault();
  elements.search.focus();
});
globalThis.addEventListener("message", (event) => {
  if (globalThis.parent === globalThis || event.source !== globalThis.parent) return;
  if (event.data?.type === "projectboard-readonly-stale") {
    if (!isSnapshotId(event.data.snapshotId)
      || event.data.snapshotId !== state.snapshot?.snapshotId) return;
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
    if (!state.snapshot) {
      fail(error?.message ?? String(error));
      return;
    }
    state.stale = true;
    renderSyncStatus();
    elements.fatalError.hidden = false;
    text(elements.fatalError, `刷新失败：${error?.message ?? String(error)}`);
    elements.workspace.hidden = false;
  }
});

boot().catch((error) => fail(error?.message ?? String(error)));
