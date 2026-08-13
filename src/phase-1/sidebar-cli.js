import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findLatestPhase0IdentityLock,
  loadPhase0IdentityLock,
  resolveReadonlyPackageBinding,
} from "./identity-lock.js";
import { INTERACTIVE_THREAD_SOURCE_KINDS } from "./catalog-policy.js";
import { defaultLaneOverridePath } from "./lane-overrides.js";
import {
  startReadonlySidebarController,
  validateDesktopExecutable,
} from "./sidebar-controller.js";

const VALUE_FLAGS = new Map([
  ["--phase0-report", "phase0Report"],
  ["--phase0-root", "phase0Root"],
]);

export function parseSidebarArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new TypeError("arguments must be strings");
  }
  const result = {
    phase0Report: null,
    phase0Root: join("artifacts", "phase-0"),
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = VALUE_FLAGS.get(flag);
    if (!key) throw new Error(`unknown argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (value.includes("\0")) throw new Error(`${flag} contains NUL`);
    seen.add(flag);
    result[key] = value;
    index += 1;
  }
  if (seen.has("--phase0-report") && seen.has("--phase0-root")) {
    throw new Error("--phase0-report and --phase0-root are mutually exclusive");
  }
  return result;
}

export async function main(argv, {
  loadLock = loadPhase0IdentityLock,
  findLock = findLatestPhase0IdentityLock,
  bindCandidate = resolveReadonlyPackageBinding,
  validateExecutable = validateDesktopExecutable,
  startController = startReadonlySidebarController,
  resolveLaneOverridePath = defaultLaneOverridePath,
} = {}) {
  const options = parseSidebarArguments(argv);
  const lock = options.phase0Report === null
    ? await findLock(options.phase0Root)
    : await loadLock(options.phase0Report);
  const binding = await bindCandidate(lock);
  const executable = await validateExecutable(binding.candidate);
  return startController({
    executable,
    lock,
    binding,
    sourceKinds: INTERACTIVE_THREAD_SOURCE_KINDS,
    laneOverridePath: resolveLaneOverridePath(),
  });
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  main(process.argv.slice(2)).then(async (controller) => {
    const summary = controller.initialSnapshot.summary;
    let lastRefreshError = null;
    process.stdout.write([
      "Codex 五栏任务看板已挂入侧栏（Codex 只读，本地栏位可编排）。",
      `项目 ${summary.projectCount} 个，任务 ${summary.taskCount} 个。`,
      "通道：remote-debugging-pipe；未开放调试端口，未创建任务或模型回合，未写入 Codex 任务状态或 Git。",
      "交互实现：native-state-v2（并行读取，不等待目录刷新）。",
      `本地栏位状态：${controller.laneOverridePath}`,
      "请保持此控制器运行；关闭 Codex 后控制器会自动退出。",
      "",
    ].join("\n"));
    controller.events.on("refreshError", (error) => {
      const message = error?.message ?? String(error);
      if (message === lastRefreshError) return;
      lastRefreshError = message;
      process.stderr.write(`Projectboard 自动刷新暂时失败（已退避重试）：${message}\n`);
    });
    controller.events.on("refreshed", () => {
      if (lastRefreshError === null) return;
      lastRefreshError = null;
      process.stdout.write("Projectboard 自动刷新已恢复。\n");
    });
    controller.events.on("mountError", (error) => {
      process.stderr.write(`Projectboard 重新挂载失败：${error?.message ?? String(error)}\n`);
    });
    controller.events.on("moveError", (error) => {
      process.stderr.write(`Projectboard 本地移动失败：${error?.message ?? String(error)}\n`);
    });
    controller.events.on("moveAccepted", ({ laneId }) => {
      process.stdout.write(`Projectboard 本地移动已接受：${laneId}\n`);
    });
    controller.events.on("openError", (error) => {
      process.stderr.write(`Projectboard 打开原任务失败：${error?.message ?? String(error)}\n`);
    });
    const outcome = await controller.done;
    if (outcome.error) {
      process.stderr.write(`Codex 侧栏控制器异常：${outcome.error.message}\n`);
      process.exitCode = 1;
    }
  }, (error) => {
    process.stderr.write(`Projectboard 侧栏启动失败：${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
