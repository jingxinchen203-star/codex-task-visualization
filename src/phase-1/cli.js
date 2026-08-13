import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareReadonlyBoardSnapshot } from "./service.js";
import { startReadonlyBoardServer } from "./readonly-server.js";

const VALUE_FLAGS = new Map([
  ["--phase0-report", "phase0Report"],
  ["--phase0-root", "phase0Root"],
]);

export function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new TypeError("arguments must be strings");
  }
  const result = {
    phase0Report: null,
    phase0Root: join("artifacts", "phase-0"),
    check: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
      seen.add(flag);
      result.check = true;
      continue;
    }
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
  prepare = prepareReadonlyBoardSnapshot,
  startServer = startReadonlyBoardServer,
} = {}) {
  const { check, ...readOptions } = parseArguments(argv);
  const snapshot = await prepare(readOptions);
  if (check) return Object.freeze({ snapshot, server: null });
  const server = await startServer({ snapshot });
  return Object.freeze({ snapshot, server });
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  main(process.argv.slice(2)).then(({ snapshot, server }) => {
    if (server === null) {
      process.stdout.write(`${JSON.stringify({
        mode: snapshot.mode,
        summary: snapshot.summary,
        source: snapshot.source,
      }, null, 2)}\n`);
      return;
    }
    process.stdout.write([
      "Codex Projectboard Phase 1 已启动（独立窗口，只读）。",
      `项目 ${snapshot.summary.projectCount} 个，任务 ${snapshot.summary.taskCount} 个。`,
      "当前不会注入 Codex、创建 turn、改变任务状态或写入 Git。",
      `打开：${server.url}`,
      "按 Ctrl+C 停止。",
      "",
    ].join("\n"));
    let closing = false;
    const close = async (exitCode) => {
      if (closing) return;
      closing = true;
      try {
        await server.close();
      } catch (error) {
        process.stderr.write(`停止 Projectboard 失败：${error?.message ?? String(error)}\n`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = exitCode;
    };
    process.once("SIGINT", () => close(130));
    process.once("SIGTERM", () => close(143));
  }, (error) => {
    process.stderr.write(`Projectboard 启动失败：${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
