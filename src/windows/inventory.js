import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const inventoryScriptPath = fileURLToPath(
  new URL("../../scripts/windows/inventory.ps1", import.meta.url),
);

export function parseInventory(raw) {
  if (!raw || !Array.isArray(raw.startApps) || !Array.isArray(raw.commands) || !Array.isArray(raw.errors)) {
    throw new TypeError("Invalid Windows inventory payload");
  }

  return {
    package: raw.package ?? null,
    startApps: raw.startApps,
    processes: Array.isArray(raw.processes) ? raw.processes : [],
    commands: raw.commands,
    errors: raw.errors.map(String),
  };
}

export async function collectWindowsInventory(exec = execFileAsync) {
  const { stdout } = await exec(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", inventoryScriptPath],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return parseInventory(JSON.parse(stdout.trim()));
}
