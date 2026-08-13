import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";

const UI_FILES = Object.freeze({
  "/": Object.freeze({ path: fileURLToPath(new URL("./ui/index.html", import.meta.url)), type: "text/html; charset=utf-8" }),
  "/app.css": Object.freeze({ path: fileURLToPath(new URL("./ui/app.css", import.meta.url)), type: "text/css; charset=utf-8" }),
  "/app.js": Object.freeze({ path: fileURLToPath(new URL("./ui/app.js", import.meta.url)), type: "text/javascript; charset=utf-8" }),
});
const KNOWN_PATHS = new Set([...Object.keys(UI_FILES), "/api/board"]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'";

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bearer(header) {
  if (typeof header !== "string") return null;
  return /^Bearer ([^\s]+)$/u.exec(header)?.[1] ?? null;
}

function responseHeaders(type) {
  return {
    "content-type": type,
    "cache-control": "no-store",
    "content-security-policy": CSP,
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function send(response, status, body, type = "application/json; charset=utf-8") {
  if (response.headersSent || response.writableEnded || response.destroyed) return false;
  response.writeHead(status, responseHeaders(type));
  response.end(body);
  return true;
}

function sendError(response, status, error) {
  return send(response, status, JSON.stringify({ error }));
}

export async function startReadonlyBoardServer({ snapshot, token = randomBytes(32).toString("base64url") }) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.mode !== "standalone-readonly") {
    throw codedError("ESNAPSHOT", "a standalone read-only board snapshot is required");
  }
  if (typeof token !== "string" || token.length < 32 || /\s/u.test(token)) {
    throw codedError("ETOKEN", "read-only board token must contain at least 32 non-whitespace characters");
  }
  const assets = new Map();
  for (const [route, asset] of Object.entries(UI_FILES)) {
    assets.set(route, Object.freeze({ ...asset, body: await readFile(asset.path) }));
  }
  const snapshotBody = JSON.stringify(snapshot);
  let port = null;
  let origin = null;
  const sockets = new Set();

  const server = http.createServer((request, response) => {
    const expectedHost = `127.0.0.1:${port}`;
    if (request.headers.host !== expectedHost) return sendError(response, 403, "host");
    let parsed;
    try {
      parsed = new URL(request.url, origin);
    } catch {
      return sendError(response, 400, "url");
    }
    if (request.url !== parsed.pathname || parsed.search || parsed.hash) return sendError(response, 404, "route");
    const pathname = parsed.pathname;
    if (request.method !== "GET") return sendError(response, KNOWN_PATHS.has(pathname) ? 405 : 404, "route");

    const asset = assets.get(pathname);
    if (asset) return send(response, 200, asset.body, asset.type);
    if (pathname !== "/api/board") return sendError(response, 404, "route");

    const suppliedToken = bearer(request.headers.authorization);
    if (!safeEqual(suppliedToken, token)) return sendError(response, 401, "authorization");
    if (request.headers.origin !== undefined && request.headers.origin !== origin) {
      return sendError(response, 403, "origin");
    }
    return send(response, 200, snapshotBody);
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
    closePromise ??= new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
      for (const socket of sockets) socket.destroy();
    });
    return closePromise;
  };
  return Object.freeze({ port, origin, url: `${origin}/#${token}`, close });
}
