import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startReadonlyBoardServer } from "../../src/phase-1/readonly-server.js";

const token = "phase1-test-token-that-is-long-enough-1234567890";
const snapshot = Object.freeze({
  schemaVersion: 1,
  mode: "standalone-readonly",
  generatedAt: "2026-08-11T00:00:00.000Z",
  summary: { projectCount: 0, taskCount: 0, activeThreadCount: 0, archivedThreadCount: 0, attentionCount: 0 },
  source: { injectedPhase1: "no-go" },
  aggregate: {
    id: "all-history",
    name: "全部历史",
    workspace: "所有工作目录",
    counts: { total: 0, attention: 0, running: 0, archived: 0 },
    lanes: [],
  },
  projects: [],
});

function assertDaybreakDocument(document) {
  assert.match(document, /class="app-bar"/u);
  assert.match(document, /class="attention-rail"/u);
  assert.match(document, /class="board-grid"/u);
  assert.match(document, /data-visual-direction="obsidian-silver"/u);
  assert.doesNotMatch(document, /boundary-banner/u);
  assert.doesNotMatch(document, /mode-badge/u);
  assert.match(document, /color-scheme:\s*dark/iu);
  assert.match(document, /--surface:\s*#181818/iu);
  assert.match(document, /--ink:\s*#e5e3df/iu);
  assert.match(document, /--accent:\s*#c9c3b8/iu);
  assert.match(document, /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/iu);
  assert.match(document, /Segoe UI Variable/u);
  assert.match(document, /Segoe Fluent Icons/u);
  assert.match(document, /@media\s*\(max-width:\s*699px\)/u);
  assert.match(document, /--muted:\s*#aaa6a0/iu);
  assert.match(document, /--attention-ink:\s*#d9ad64/iu);
  assert.doesNotMatch(document, /prefers-color-scheme:\s*dark/iu);
  assert.match(document, /#attention-total\s*\{[^}]*color:\s*var\(--attention-ink\)/isu);
  assert.match(document, /\.attention-item strong\s*\{[^}]*color:\s*var\(--attention-ink\)/isu);
  assert.match(document, /\.task-badge\.active\s*\{[^}]*color:\s*var\(--accent-strong\)/isu);
  assert.match(document, /\.task-badge\.attention\s*\{[^}]*color:\s*var\(--attention-ink\)/isu);
  assert.match(document, /\.dialog-attention\s*\{[^}]*color:\s*var\(--attention-ink\)/isu);
  assert.match(document, /aria-keyshortcuts="Control\+K Meta\+K"/u);
  assert.match(document, /class="switch-track"/u);
  assert.match(document, /\.task-card-title,\s*\.task-next\s*\{[^}]*overflow-wrap:\s*anywhere/isu);
}

function rawStatus(server, { path = "/api/board", method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: server.port, path, method, headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

test("standalone Phase 1 server exposes a token-gated GET-only board and no remote assets", async (t) => {
  const server = await startReadonlyBoardServer({ snapshot, token });
  t.after(() => server.close());
  assert.match(server.url, new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/#${token}$`, "u"));

  const shell = await fetch(server.origin);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-security-policy"), /default-src 'none'/u);
  assert.match(shell.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
  assert.equal(shell.headers.get("cache-control"), "no-store");
  const html = await shell.text();
  assert.match(html, /Codex Projectboard/u);
  assert.equal(html.includes(token), false);
  assert.equal(/https?:\/\/(?!127\.0\.0\.1)/u.test(html), false);

  const script = await (await fetch(`${server.origin}/app.js`)).text();
  assert.match(script, /projectboard-readonly-snapshot/u);
  const css = await (await fetch(`${server.origin}/app.css`)).text();
  const document = `${html}\n${css}\n${script}`;
  assertDaybreakDocument(document);
  assert.match(document, /all-history/u);
  assert.match(document, /全部历史/u);
  assert.doesNotMatch(document, /turn\/start|thread\/(?:start|archive|delete)/u);
  assert.doesNotMatch(document, /https?:\/\/(?!127\.0\.0\.1(?::\d+)?(?:\/|["']))/u);
  assert.equal(script.includes(token), false);
  assert.match(css, /grid-template-columns:\s*repeat\(5/u);
  assert.match(css, /@media\s*\(max-width:\s*699px\)/u);
  assert.equal(css.includes("max-width: 1439px"), false);

  assert.equal((await fetch(`${server.origin}/api/board`)).status, 401);
  assert.equal((await fetch(`${server.origin}/api/board`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(`${server.origin}/api/board`, {
    headers: { authorization: `Bearer ${token}`, origin: "https://example.invalid" },
  })).status, 403);
  const board = await fetch(`${server.origin}/api/board`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(board.status, 200);
  assert.deepEqual(await board.json(), snapshot);
  assert.equal(board.headers.get("access-control-allow-origin"), null);

  assert.equal(await rawStatus(server, { path: "/api/board?x=1", headers: { authorization: `Bearer ${token}` } }), 404);
  assert.equal(await rawStatus(server, { method: "POST", headers: { authorization: `Bearer ${token}` } }), 405);
  assert.equal(await rawStatus(server, { headers: { host: "example.invalid", authorization: `Bearer ${token}` } }), 403);

  await Promise.all([server.close(), server.close()]);
  await assert.rejects(fetch(server.origin));
});
