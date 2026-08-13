import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  CAPABILITY_MATRIX,
  probeLocalApiContract,
  startLocalApiServer,
} from "../../src/local-api/server.js";

const principals = [
  { token: "injected-token", origins: ["app://codex"], capabilities: CAPABILITY_MATRIX.injected },
  { token: "standalone-token", origins: ["$self"], capabilities: CAPABILITY_MATRIX.standalone },
  { token: "mcp-token", origins: ["projectboard-mcp://local"], capabilities: CAPABILITY_MATRIX.mcp },
];

function headers(server, token, origin, extra = {}) {
  return {
    host: `127.0.0.1:${server.port}`,
    origin,
    authorization: `Bearer ${token}`,
    ...extra,
  };
}

function postHeaders(server, token, origin, extra = {}) {
  return headers(server, token, origin, {
    "content-type": "application/json; charset=utf-8",
    "x-projectboard-version": "1",
    ...extra,
  });
}

function rawStatus(server, { path = "/state", method = "POST", requestHeaders, body = "{}" }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: server.port,
      path,
      method,
      headers: requestHeaders,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("local API enforces the principal capability contract", async (t) => {
  const server = await startLocalApiServer({ principals, bootstrapNonce: "one-shot" });
  t.after(() => server.close());

  const injected = headers(server, "injected-token", "app://codex");
  const standalone = headers(server, "standalone-token", server.origin);
  const mcp = headers(server, "mcp-token", "projectboard-mcp://local");

  assert.equal((await fetch(`${server.origin}/state`, { headers: injected })).status, 200);
  assert.equal((await fetch(`${server.origin}/state`, {
    method: "POST",
    headers: postHeaders(server, "injected-token", "app://codex"),
    body: JSON.stringify({ revision: 1 }),
  })).status, 200);
  assert.equal((await fetch(`${server.origin}/evidence`, {
    method: "POST",
    headers: postHeaders(server, "injected-token", "app://codex"),
    body: "{}",
  })).status, 403);

  assert.equal((await fetch(`${server.origin}/state`, { headers: standalone })).status, 200);
  assert.equal((await fetch(`${server.origin}/evidence`, {
    method: "POST",
    headers: postHeaders(server, "standalone-token", server.origin),
    body: "{}",
  })).status, 403);

  assert.equal((await fetch(`${server.origin}/evidence`, {
    method: "POST",
    headers: postHeaders(server, "mcp-token", "projectboard-mcp://local"),
    body: JSON.stringify({ kind: "claim" }),
  })).status, 200);
  assert.equal((await fetch(`${server.origin}/state`, { headers: mcp })).status, 403);

  const events = await fetch(`${server.origin}/events`, { headers: injected });
  assert.equal(events.status, 200);
  assert.match(events.headers.get("content-type"), /^application\/x-ndjson\b/u);
  assert.equal(events.headers.get("cache-control"), "no-store");
  assert.equal(events.headers.get("access-control-allow-origin"), null);
  assert.equal(events.headers.get("set-cookie"), null);
  assert.deepEqual(JSON.parse((await events.text()).trim()), { type: "ready" });
});

test("local API validates request shape, exact paths, and one-shot bootstrap", async (t) => {
  const server = await startLocalApiServer({ principals, bootstrapNonce: "one-shot" });
  t.after(() => server.close());
  const good = postHeaders(server, "standalone-token", server.origin);

  assert.equal((await fetch(`${server.origin}/state`, { method: "POST", body: "{}" })).status, 401);
  assert.equal(await rawStatus(server, { requestHeaders: { ...good, host: "example.invalid" } }), 403);
  assert.equal((await fetch(`${server.origin}/state`, {
    method: "POST",
    headers: { ...good, origin: "https://example.invalid" },
    body: "{}",
  })).status, 403);
  assert.equal((await fetch(`${server.origin}/state`, {
    method: "POST",
    headers: { ...good, authorization: "Bearer wrong" },
    body: "{}",
  })).status, 401);
  assert.equal((await fetch(`${server.origin}/state`, {
    method: "POST",
    headers: { ...good, "content-type": "text/plain" },
    body: "{}",
  })).status, 415);
  assert.equal((await fetch(`${server.origin}/state`, {
    method: "POST",
    headers: { ...good, "x-projectboard-version": "2" },
    body: "{}",
  })).status, 415);
  assert.equal((await fetch(`${server.origin}/state`, { method: "POST", headers: good, body: "{" })).status, 400);
  assert.equal((await fetch(`${server.origin}/state`, {
    method: "POST",
    headers: good,
    body: JSON.stringify({ value: "x".repeat(65_537) }),
  })).status, 413);

  assert.equal(await rawStatus(server, { path: "/state?write=true", requestHeaders: good }), 404);
  assert.equal(await rawStatus(server, { path: "//state", requestHeaders: good }), 404);
  assert.equal(await rawStatus(server, { path: "/%2e%2e/state", requestHeaders: good }), 404);
  assert.equal((await fetch(`${server.origin}/state`, { method: "DELETE", headers: headers(server, "standalone-token", server.origin) })).status, 405);

  const redeem = () => fetch(`${server.origin}/bootstrap`, {
    method: "POST",
    headers: good,
    body: JSON.stringify({ nonce: "one-shot" }),
  }).then((response) => response.status);
  const statuses = await Promise.all([redeem(), redeem()]);
  assert.deepEqual(statuses.toSorted(), [200, 409]);
  assert.equal(await redeem(), 409);

  const response = await fetch(`${server.origin}/state`, { headers: headers(server, "standalone-token", server.origin) });
  assert.equal((await response.text()).includes("standalone-token"), false);
});

test("configuration, probe summary, and owned close fail closed", async () => {
  assert.equal(Object.isFrozen(CAPABILITY_MATRIX), true);
  assert.equal(Object.values(CAPABILITY_MATRIX).every(Object.isFrozen), true);
  await assert.rejects(
    startLocalApiServer({
      bootstrapNonce: "nonce",
      principals: [
        { token: "duplicate", origins: ["app://codex"], capabilities: ["read:state"] },
        { token: "duplicate", origins: ["app://codex"], capabilities: ["read:state"] },
      ],
    }),
    (error) => error.code === "EPRINCIPALS",
  );
  await assert.rejects(
    startLocalApiServer({
      bootstrapNonce: "nonce",
      principals: [{ token: "token", origins: ["app://codex"], capabilities: ["admin:all"] }],
    }),
    (error) => error.code === "EPRINCIPALS",
  );

  const summary = await probeLocalApiContract();
  assert.deepEqual(summary, {
    status: "pass",
    authorizedStatus: 200,
    deniedStatus: 401,
    eventsReady: true,
    closed: true,
  });
  assert.equal(JSON.stringify(summary).includes("token"), false);

  const server = await startLocalApiServer({ principals, bootstrapNonce: "nonce" });
  await Promise.all([server.close(), server.close(), server.close()]);
  await assert.rejects(fetch(`${server.origin}/state`));
});

test("an aborted JSON body does not double-respond or stop the owned server", async (t) => {
  const server = await startLocalApiServer({ principals, bootstrapNonce: "nonce" });
  t.after(() => server.close());
  const requestHeaders = postHeaders(server, "standalone-token", server.origin);

  await new Promise((resolve) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: server.port,
      path: "/state",
      method: "POST",
      headers: requestHeaders,
    });
    request.on("error", () => resolve());
    request.on("socket", () => {
      request.write('{"partial":');
      setTimeout(() => request.destroy(), 5);
    });
    setTimeout(resolve, 100);
  });

  const response = await fetch(`${server.origin}/state`, {
    headers: headers(server, "standalone-token", server.origin),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, state: null });
});
