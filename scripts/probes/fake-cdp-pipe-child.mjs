import { createReadStream, writeSync } from "node:fs";

const input = createReadStream(null, { fd: 3, autoClose: true });
let buffered = Buffer.alloc(0);
let targetPolls = 0;
const framesBySession = new Map();
const requestedCloseCode = Number(process.argv.find((argument) => argument.startsWith("--close-code="))?.split("=")[1] ?? 0);
const closeWithoutResponse = process.argv.includes("--close-without-response");
const closeRpcError = process.argv.includes("--close-rpc-error");
const ignoreClose = process.argv.includes("--ignore-close");

if (process.argv.includes("--flood-stderr")) {
  const block = Buffer.alloc(64 * 1024, "x");
  for (let index = 0; index < 64; index += 1) writeSync(2, block);
}

function send(message, callback = () => {}) {
  const frame = Buffer.concat([Buffer.from(JSON.stringify(message), "utf8"), Buffer.from([0])]);
  writeSync(4, frame);
  callback();
}

function evaluationValue(expression, sessionId) {
  if (!framesBySession.has(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
  const current = framesBySession.get(sessionId);
  if (expression.includes("projectboard-phase0:mount")) {
    framesBySession.set(sessionId, 1);
    return { status: "loaded", count: 1 };
  }
  if (expression.includes("projectboard-phase0:count")) return { status: "count", count: current };
  if (expression.includes("projectboard-phase0:remove")) {
    framesBySession.set(sessionId, 0);
    return { status: "removed", removed: current };
  }
  throw new Error("Unknown evaluation expression");
}

function respond(request) {
  const { id, method, params = {}, sessionId } = request;
  try {
    if (method === "Browser.getVersion") {
      send({ id, result: { product: "FakeCodex/1.0", protocolVersion: "1.3" } });
      return;
    }
    if (method === "Target.getTargets") {
      targetPolls += 1;
      const targetInfos = [
        ...(targetPolls > 1 ? [{ targetId: "app-beta", type: "page", url: "app://codex/beta" }] : []),
        { targetId: "foreign", type: "page", url: "https://example.test/" },
        { targetId: "worker", type: "worker", url: "app://codex/worker" },
        { targetId: "app-alpha", type: "page", url: "app://codex/alpha" },
      ];
      send({ id, result: { targetInfos } });
      return;
    }
    if (method === "Target.attachToTarget") {
      if (!params.flatten) throw new Error("flatten must be true");
      const session = `session:${params.targetId}`;
      framesBySession.set(session, 0);
      send({ id, result: { sessionId: session } });
      return;
    }
    if (method === "Runtime.evaluate") {
      const value = evaluationValue(params.expression, sessionId);
      send({ id, result: { result: { type: "object", value } } });
      return;
    }
    if (method === "Browser.close") {
      if (ignoreClose) return;
      if (closeWithoutResponse) process.exit(requestedCloseCode);
      if (closeRpcError) {
        send({ id, error: { code: -32000, message: "close rejected" } });
        process.exit(0);
      }
      send({ id, result: {} });
      process.exit(requestedCloseCode);
    }
    send({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
  } catch (error) {
    send({ id, error: { code: -32000, message: error.message } });
  }
}

input.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  let delimiter;
  while ((delimiter = buffered.indexOf(0)) >= 0) {
    const frame = buffered.subarray(0, delimiter);
    buffered = buffered.subarray(delimiter + 1);
    if (frame.length === 0) continue;
    respond(JSON.parse(frame.toString("utf8")));
  }
});
