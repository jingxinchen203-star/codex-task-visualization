import { createHash } from "node:crypto";
import { win32 as path } from "node:path";
import { validateLaneOverrides } from "./lane-overrides.js";

export const BOARD_LANES = Object.freeze([
  Object.freeze({ id: "inbox", label: "收集箱", description: "尚未形成可靠计划的导入任务" }),
  Object.freeze({ id: "planned", label: "已规划", description: "目标与验收标准已经明确" }),
  Object.freeze({ id: "running", label: "执行中", description: "Codex 当前存在活动状态" }),
  Object.freeze({ id: "review", label: "待验收", description: "具备完整验证事实，等待人工确认" }),
  Object.freeze({ id: "done", label: "完成", description: "已经由用户明确验收" }),
]);

const READ_ONLY_METHODS = new Set(["initialize", "initialized", "account/read", "thread/list"]);
const STATUS_TYPES = new Set(["notLoaded", "idle", "systemError", "active"]);

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function compareText(left, right) {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compactText(value, limit) {
  if (typeof value !== "string") return "";
  const compact = value.replaceAll(/\s+/gu, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeWorkspace(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw codedError("ETHREADSHAPE", "thread cwd must be a nonempty path");
  }
  let normalized = path.normalize(value.replaceAll("/", "\\"));
  if (!path.isAbsolute(normalized)) throw codedError("ETHREADSHAPE", "thread cwd must be absolute");
  const root = path.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith("\\")) normalized = normalized.slice(0, -1);
  return normalized;
}

function workspaceKey(value) {
  return normalizeWorkspace(value).toLowerCase();
}

function projectId(key) {
  return `workspace-${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 20)}`;
}

function validateThread(thread) {
  const valid = thread
    && typeof thread === "object"
    && !Array.isArray(thread)
    && typeof thread.id === "string"
    && thread.id.length > 0
    && typeof thread.preview === "string"
    && Number.isFinite(thread.createdAt)
    && Number.isFinite(thread.updatedAt)
    && thread.status
    && typeof thread.status === "object"
    && !Array.isArray(thread.status)
    && STATUS_TYPES.has(thread.status.type);
  if (!valid) throw codedError("ETHREADSHAPE", "thread metadata is malformed");
  if (thread.name !== null && thread.name !== undefined && typeof thread.name !== "string") {
    throw codedError("ETHREADSHAPE", "thread name is malformed");
  }
  const activeFlags = thread.status.type === "active" ? thread.status.activeFlags : [];
  if (thread.status.type === "active" && (!Array.isArray(activeFlags)
    || activeFlags.some((flag) => flag !== "waitingOnApproval" && flag !== "waitingOnUserInput"))) {
    throw codedError("ETHREADSHAPE", "thread active flags are malformed");
  }
  return activeFlags;
}

function attentionFor(status, activeFlags) {
  if (activeFlags.includes("waitingOnApproval")) return Object.freeze({ kind: "approval", label: "等待审批" });
  if (activeFlags.includes("waitingOnUserInput")) return Object.freeze({ kind: "user-input", label: "等待你的输入" });
  if (status === "systemError") return Object.freeze({ kind: "system-error", label: "Codex 状态异常" });
  return null;
}

function laneFor(status) {
  return status === "active" ? "running" : "inbox";
}

function nextActionFor({ archived, status, activeFlags }) {
  if (activeFlags.includes("waitingOnApproval")) return "回到原 Codex 任务检查并处理审批";
  if (activeFlags.includes("waitingOnUserInput")) return "回到原 Codex 任务并提供所需信息";
  if (status === "systemError") return "打开原 Codex 任务检查异常状态";
  if (status === "active") return "Codex 正在处理；此看板不会发送任何控制命令";
  if (archived) return "已导入归档，尚未整理";
  return "打开原 Codex 任务确认下一步";
}

function taskFromThread(thread, archived, project, laneOverrides) {
  const activeFlags = validateThread(thread);
  const previewTitle = thread.preview.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
  const title = compactText(thread.name, 120) || compactText(previewTitle, 120) || "未命名任务";
  const attention = attentionFor(thread.status.type, activeFlags);
  return Object.freeze({
    id: thread.id,
    threadId: thread.id,
    projectId: project.id,
    title,
    state: laneOverrides.get(thread.id) ?? laneFor(thread.status.type),
    archived,
    sourceStatus: thread.status.type,
    activeFlags: Object.freeze([...activeFlags]),
    attention,
    nextAction: nextActionFor({ archived, status: thread.status.type, activeFlags }),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  });
}

function taskOrder(left, right) {
  if (Boolean(left.attention) !== Boolean(right.attention)) return left.attention ? -1 : 1;
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  return compareText(left.id, right.id);
}

function projectOrder(left, right) {
  if (left.counts.attention !== right.counts.attention) return right.counts.attention - left.counts.attention;
  if (left.counts.running !== right.counts.running) return right.counts.running - left.counts.running;
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  const nameOrder = compareText(left.name, right.name);
  if (nameOrder !== 0) return nameOrder;
  return compareText(left.id, right.id);
}

function validateIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw codedError("EIDENTITY", "read-only identity evidence is required");
  }
  if (!Array.isArray(identity.outboundMethods)
    || identity.outboundMethods.some((method) => !READ_ONLY_METHODS.has(method))) {
    throw codedError("EREADONLYMETHOD", "snapshot contains a method outside the read-only App Server allowlist");
  }
}

function frozenSource(identity) {
  return Object.freeze({
    phase0RunId: identity.phase0RunId ?? null,
    standalonePhase1: identity.standalonePhase1 ?? null,
    injectedPhase1: "no-go",
    candidateVersion: identity.candidateVersion ?? null,
    executionDigest: identity.executionDigest ?? null,
    identityContinuity: identity.identityContinuity ?? "exact-phase0",
    accountType: identity.accountType ?? null,
    outboundMethods: Object.freeze([...identity.outboundMethods]),
  });
}

export function buildReadonlyBoardSnapshot({
  activeThreads,
  archivedThreads,
  identity,
  laneOverrides = [],
  generatedAt = new Date().toISOString(),
}) {
  if (!Array.isArray(activeThreads) || !Array.isArray(archivedThreads)) {
    throw new TypeError("activeThreads and archivedThreads must be arrays");
  }
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) {
    throw new TypeError("generatedAt must be an ISO timestamp");
  }
  validateIdentity(identity);
  const overrideMap = new Map(validateLaneOverrides(laneOverrides)
    .map(({ threadId, laneId }) => [threadId, laneId]));

  const seen = new Set();
  const activeIds = new Set();
  const archivedIds = new Set();
  const projects = new Map();
  const add = (thread, archived) => {
    if (!thread || typeof thread.id !== "string" || thread.id.length === 0) {
      throw codedError("ETHREADSHAPE", "thread id is required");
    }
    seen.add(thread.id);
    const normalized = normalizeWorkspace(thread.cwd);
    const key = workspaceKey(normalized);
    let project = projects.get(key);
    if (!project) {
      const name = path.basename(normalized) || normalized;
      project = { id: projectId(key), name, workspace: normalized, key, tasks: [] };
      projects.set(key, project);
    }
    project.tasks.push(taskFromThread(thread, archived, project, overrideMap));
  };
  for (const thread of activeThreads) {
    if (!thread || typeof thread.id !== "string" || thread.id.length === 0) {
      throw codedError("ETHREADSHAPE", "thread id is required");
    }
    if (activeIds.has(thread.id)) {
      throw codedError("ETHREADDUPLICATE", `thread ${thread.id} repeated in active catalog`);
    }
    activeIds.add(thread.id);
    add(thread, false);
  }
  for (const thread of archivedThreads) {
    if (!thread || typeof thread.id !== "string" || thread.id.length === 0) {
      throw codedError("ETHREADSHAPE", "thread id is required");
    }
    if (archivedIds.has(thread.id)) {
      throw codedError("ETHREADDUPLICATE", `thread ${thread.id} repeated in archived catalog`);
    }
    archivedIds.add(thread.id);
    if (!activeIds.has(thread.id)) add(thread, true);
  }

  const projectedProjects = [...projects.values()].map((project) => {
    const lanes = BOARD_LANES.map((lane) => Object.freeze({
      ...lane,
      tasks: Object.freeze(project.tasks.filter(({ state }) => state === lane.id).sort(taskOrder)),
    }));
    const attention = project.tasks.filter(({ attention: value }) => value).length;
    const running = project.tasks.filter(({ state }) => state === "running").length;
    const archived = project.tasks.filter(({ archived: value }) => value).length;
    return Object.freeze({
      id: project.id,
      name: project.name,
      status: "archived",
      identitySource: "cwd",
      workspace: project.workspace,
      updatedAt: Math.max(...project.tasks.map(({ updatedAt }) => updatedAt), 0),
      counts: Object.freeze({ total: project.tasks.length, attention, running, archived }),
      lanes: Object.freeze(lanes),
    });
  }).sort(projectOrder);

  const attentionCount = projectedProjects.reduce((sum, project) => sum + project.counts.attention, 0);
  const aggregateTasks = projectedProjects.flatMap((project) => project.lanes.flatMap(({ tasks }) => tasks));
  const aggregate = Object.freeze({
    id: "all-history",
    name: "全部历史",
    status: "aggregate",
    identitySource: "projection",
    workspace: "所有工作目录",
    updatedAt: Math.max(...aggregateTasks.map(({ updatedAt }) => updatedAt), 0),
    counts: Object.freeze({
      total: aggregateTasks.length,
      attention: aggregateTasks.filter(({ attention }) => attention).length,
      running: aggregateTasks.filter(({ state }) => state === "running").length,
      archived: aggregateTasks.filter(({ archived }) => archived).length,
    }),
    lanes: Object.freeze(BOARD_LANES.map((lane) => Object.freeze({
      ...lane,
      tasks: Object.freeze(aggregateTasks.filter(({ state }) => state === lane.id).sort(taskOrder)),
    }))),
  });
  const source = frozenSource(identity);
  const summary = Object.freeze({
    projectCount: projectedProjects.length,
    taskCount: seen.size,
    activeThreadCount: activeIds.size,
    archivedThreadCount: [...archivedIds].filter((id) => !activeIds.has(id)).length,
    attentionCount,
  });
  const payload = {
    schemaVersion: 1,
    mode: "standalone-readonly",
    generatedAt,
    source,
    summary,
    aggregate,
    projects: Object.freeze(projectedProjects),
  };
  const { generatedAt: _generatedAt, ...identityPayload } = payload;
  const snapshotId = createHash("sha256")
    .update(JSON.stringify(identityPayload), "utf8")
    .digest("hex");
  return Object.freeze({ ...payload, snapshotId });
}
