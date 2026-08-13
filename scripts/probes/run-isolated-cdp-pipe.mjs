import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { probeDirectPipe } from "../../src/cdp/pipe-probe.js";
import { classifyExecutionPath } from "../../src/process/security-policy.js";

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("usage: run-isolated-cdp-pipe.mjs <package ChatGPT.exe> <empty temporary profile>");
  }
  const [executable, profile] = argv.map((value) => path.resolve(value));
  classifyExecutionPath(executable);
  classifyExecutionPath(profile);
  const normalizedExecutable = executable.replaceAll("/", "\\");
  if (!/\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$/iu.test(normalizedExecutable)) {
    throw new Error("the executable must be the OpenAI.Codex package ChatGPT.exe");
  }
  if (!path.basename(profile).startsWith("projectboard-injection-probe-")) {
    throw new Error("the profile must be a dedicated Projectboard injection probe directory");
  }
  return { executable, profile };
}

function outputResult(result) {
  return {
    ok: true,
    browserVersion: result.browserVersion,
    mountResult: result.mountResult,
    rendererCount: result.renderers.length,
    renderers: result.renderers.map((renderer) => ({
      targetId: renderer.targetId,
      mounts: renderer.mounts,
      count: renderer.count,
      removed: renderer.removed,
      exceptionCount: renderer.exceptionDetails.length,
    })),
    child: result.child,
    outboundMethods: result.outbound.map(({ method }) => method),
    fixtureClosed: result.fixture.closed,
    stderr: { bytes: result.stderr.bytes, truncated: result.stderr.truncated },
  };
}

function diagnosticStderr(stderr, profile) {
  const value = stderr && typeof stderr === "object" ? stderr : { text: "", bytes: 0, truncated: false };
  const escapedProfile = profile.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const profilePattern = new RegExp(escapedProfile, "giu");
  const diagnosticPattern = /(?:\[(?:ERROR|FATAL|WARNING):|check failed|remote.?debug|devtools|pipe|sandbox|gpu|crash)/iu;
  const lines = String(value.text ?? "")
    .split(/\r?\n/gu)
    .filter((line) => diagnosticPattern.test(line))
    .slice(-24)
    .map((line) => line
      .replace(profilePattern, "<probe-profile>")
      .replaceAll(/(?:https?|wss?):\/\/\S+/giu, "<url>")
      .replaceAll(/\b(?:authorization|bearer|cookie|token)=\S+/giu, "$1=<redacted>")
      .slice(0, 1_000));
  return { bytes: value.bytes ?? 0, truncated: value.truncated === true, lines };
}

function outputError(error, profile) {
  return {
    ok: false,
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: error?.message ?? String(error),
    cleanup: error?.cleanup ?? null,
    probe: error?.probe ?? null,
    stderr: diagnosticStderr(error?.stderr, profile),
  };
}

let profileForError = "<unparsed-profile>";
try {
  const { executable, profile } = parseArguments(process.argv.slice(2));
  profileForError = profile;
  const [executableInfo, profileInfo, profileEntries] = await Promise.all([
    stat(executable),
    stat(profile),
    readdir(profile),
  ]);
  if (!executableInfo.isFile()) throw new Error("the package executable is not a file");
  if (!profileInfo.isDirectory() || profileEntries.length !== 0) {
    throw new Error("the temporary profile must be an existing empty directory");
  }
  const result = await probeDirectPipe(
    executable,
    [
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--enable-logging=stderr",
      "--v=1",
    ],
    {
      requestTimeoutMs: 8_000,
      childCloseTimeoutMs: 3_000,
      targetPollAttempts: 30,
      targetPollIntervalMs: 300,
      targetPollDeadlineMs: 12_000,
      targetStableSnapshots: 2,
      frameLoadTimeoutMs: 3_000,
      fixtureMode: "blob",
    },
  );
  process.stdout.write(`${JSON.stringify(outputResult(result), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(outputError(error, profileForError), null, 2)}\n`);
  process.exitCode = 1;
}
