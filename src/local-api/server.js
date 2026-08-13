import http from "node:http";
import { timingSafeEqual } from "node:crypto";

const MAX_JSON_BYTES = 65_536;
const API_VERSION = "1";

const ROUTES = new Map([
  ["GET /events", "read:events"],
  ["GET /state", "read:state"],
  ["POST /bootstrap", "bootstrap"],
  ["POST /state", "write:state"],
  ["POST /evidence", "write:evidence"],
]);
const KNOWN_PATHS = new Set([...ROUTES.keys()].map((key) => key.slice(key.indexOf(" ") + 1)));
const KNOWN_CAPABILITIES = new Set(ROUTES.values());

export const CAPABILITY_MATRIX = Object.freeze({
  injected: Object.freeze(["read:events", "read:state", "write:state", "bootstrap"]),
  standalone: Object.freeze(["read:events", "read:state", "write:state", "bootstrap"]),
  mcp: Object.freeze(["write:evidence"]),
});

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sendJson(response, status, value, extraHeaders = {}) {
  if (response.headersSent || response.writableEnded || response.destroyed) return false;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
  return true;
}

function safeTextEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validatePrincipals(principals) {
  if (!Array.isArray(principals) || principals.length === 0) {
    throw codedError("EPRINCIPALS", "at least one local API principal is required");
  }
  const tokens = new Set();
  return Object.freeze(principals.map((principal) => {
    if (!principal || typeof principal !== "object") throw codedError("EPRINCIPALS", "principal must be an object");
    const { token } = principal;
    if (typeof token !== "string" || token.length === 0 || tokens.has(token)) {
      throw codedError("EPRINCIPALS", "principal tokens must be nonempty and unique");
    }
    tokens.add(token);
    if (!Array.isArray(principal.origins) || principal.origins.length === 0) {
      throw codedError("EPRINCIPALS", "principal origins must be a nonempty array");
    }
    const origins = [...new Set(principal.origins)];
    if (origins.some((origin) => typeof origin !== "string" || origin.length === 0 || origin === "*")) {
      throw codedError("EPRINCIPALS", "principal origins must be exact nonempty strings");
    }
    if (!Array.isArray(principal.capabilities) || principal.capabilities.length === 0) {
      throw codedError("EPRINCIPALS", "principal capabilities must be a nonempty array");
    }
    const capabilities = [...new Set(principal.capabilities)];
    if (capabilities.some((capability) => !KNOWN_CAPABILITIES.has(capability))) {
      throw codedError("EPRINCIPALS", "principal contains an unknown capability");
    }
    return Object.freeze({ token, origins: Object.freeze(origins), capabilities: Object.freeze(capabilities) });
  }));
}

function bearerToken(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  return match?.[1] ?? null;
}

function readJsonBody(request, response) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let oversized = false;
    const chunks = [];
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      action(value);
    };
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) {
        oversized = true;
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once("aborted", () => finish(reject, codedError("EREQUESTABORTED", "request body aborted")));
    request.once("error", (error) => finish(reject, error));
    request.once("end", () => {
      if (settled) return;
      if (oversized) return finish(reject, codedError("EBODYSIZE", "request body exceeds byte limit"));
      try {
        const text = Buffer.concat(chunks, bytes).toString("utf8");
        finish(resolve, JSON.parse(text || "{}"));
      } catch {
        finish(reject, codedError("EJSON", "request body is not valid JSON"));
      }
    });
    response.once("close", () => {
      if (!response.writableEnded) finish(reject, codedError("ERESPONSECLOSED", "response closed before request completed"));
    });
  });
}

export async function startLocalApiServer({ principals, bootstrapNonce }) {
  const configuredPrincipals = validatePrincipals(principals);
  if (typeof bootstrapNonce !== "string" || bootstrapNonce.length === 0) {
    throw codedError("ENONCE", "bootstrapNonce must be a nonempty string");
  }
  let nonce = bootstrapNonce;
  let port = null;
  let origin = null;
  const sockets = new Set();

  const server = http.createServer(async (request, response) => {
    const expectedHost = `127.0.0.1:${port}`;
    if (request.headers.host !== expectedHost) return sendJson(response, 403, { error: "host" });

    const suppliedToken = bearerToken(request.headers.authorization);
    const principal = suppliedToken
      ? configuredPrincipals.find((candidate) => safeTextEqual(candidate.token, suppliedToken))
      : null;
    if (!principal) return sendJson(response, 401, { error: "authorization" });

    const allowedOrigins = principal.origins.map((value) => value === "$self" ? origin : value);
    if (!allowedOrigins.includes(request.headers.origin)) return sendJson(response, 403, { error: "origin" });

    let parsedUrl;
    try {
      parsedUrl = new URL(request.url, origin);
    } catch {
      return sendJson(response, 400, { error: "url" });
    }
    const pathname = parsedUrl.pathname;
    if (request.url !== pathname || parsedUrl.search || parsedUrl.hash) return sendJson(response, 404, { error: "route" });
    const capability = ROUTES.get(`${request.method} ${pathname}`);
    if (!capability) {
      return sendJson(response, KNOWN_PATHS.has(pathname) ? 405 : 404, { error: "route" });
    }
    if (!principal.capabilities.includes(capability)) return sendJson(response, 403, { error: "capability" });

    if (request.method === "GET") {
      if (pathname === "/events") {
        if (response.headersSent || response.destroyed) return false;
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(`${JSON.stringify({ type: "ready" })}\n`);
        return true;
      }
      return sendJson(response, 200, { ok: true, state: null });
    }

    const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json" || request.headers["x-projectboard-version"] !== API_VERSION) {
      return sendJson(response, 415, { error: "request-shape" });
    }

    try {
      const body = await readJsonBody(request, response);
      if (pathname === "/bootstrap") {
        if (!nonce || !safeTextEqual(body?.nonce, nonce)) return sendJson(response, 409, { error: "nonce" });
        nonce = null;
        return sendJson(response, 200, { ok: true });
      }
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      if (error?.code === "EBODYSIZE") return sendJson(response, 413, { error: "body-size" });
      if (error?.code === "EJSON") return sendJson(response, 400, { error: "json" });
      return sendJson(response, 400, { error: "request" });
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  port = server.address().port;
  origin = `http://127.0.0.1:${port}`;

  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
      for (const socket of sockets) socket.destroy();
    });
    return closePromise;
  };
  return Object.freeze({ port, origin, close });
}

export async function probeLocalApiContract() {
  const server = await startLocalApiServer({
    bootstrapNonce: "probe-once",
    principals: [{
      token: "probe-bearer",
      origins: ["app://codex"],
      capabilities: CAPABILITY_MATRIX.injected,
    }],
  });
  let authorizedStatus = null;
  let deniedStatus = null;
  let eventsReady = false;
  try {
    const authorizedHeaders = {
      host: `127.0.0.1:${server.port}`,
      origin: "app://codex",
      authorization: "Bearer probe-bearer",
    };
    authorizedStatus = (await fetch(`${server.origin}/state`, { headers: authorizedHeaders })).status;
    deniedStatus = (await fetch(`${server.origin}/state`)).status;
    const events = await fetch(`${server.origin}/events`, { headers: authorizedHeaders });
    eventsReady = events.status === 200 && JSON.parse((await events.text()).trim()).type === "ready";
  } finally {
    await server.close();
  }
  return Object.freeze({
    status: authorizedStatus === 200 && deniedStatus === 401 && eventsReady ? "pass" : "fail",
    authorizedStatus,
    deniedStatus,
    eventsReady,
    closed: true,
  });
}
