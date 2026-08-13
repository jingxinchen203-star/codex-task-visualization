# Codex Projectboard Phase 0 Compatibility Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a non-production Windows compatibility harness that records one Windows environment prerequisite and proves or rejects the six safety assumptions required before Codex Projectboard may gain injected UI or execution permissions.

**Architecture:** A dependency-free Node.js ESM CLI orchestrates isolated probes for Windows app discovery, Codex App Server JSONL, CDP transport, localhost authentication, approval identity, and at-most-once crash recovery. Safe probes run by default; any probe that restarts Codex, creates a persistent Codex thread, invokes a model turn, or requests an approval requires a separate explicit flag and records the granted scope. Every run produces immutable JSON evidence and a human-readable Go/No-Go report; the harness never archives or deletes native Codex threads.

**Tech Stack:** Node.js 22+ ESM, built-in `node:test`, `node:http`, `node:child_process`, `node:crypto`, `node:sqlite`, PowerShell 5.1+, generated Codex App Server JSON Schema, Windows Store activation APIs.

---

## Scope decomposition

The approved product specification contains several independently testable systems. This plan implements only Phase 0. The following plans are created after their entry gates pass:

1. Phase 1 Core, read-only history import, archived projections, duplicate suggestions, ResumePacket, and JSON export/import.
2. Phase 1 Projectboard UI, five-lane wide layout, narrow single-state layout, attention inbox, and optional Codex injection adapter.
3. Phase 2 manual App Server execution, approval UI, verifier evidence, and control transfer.
4. Phase 3 scheduler, three-Run concurrency, durable dispatch, worktree isolation, Skill, and MCP shim.

Phase 0 may conclude that injected UI is No-Go while standalone Phase 1 remains Go. It may also conclude that Phase 2/3 execution is No-Go while read-only indexing remains Go.

## Official protocol constraints

- Use `codex app-server` stdio transport. It is newline-delimited JSON without a `jsonrpc` field.
- Send one `initialize` request per connection, await its response, then send the `initialized` notification before other requests.
- Generate JSON Schema from the selected binary with `codex app-server generate-json-schema --out <dir>` and store the binary hash beside it.
- Stay on the stable API surface; do not set `experimentalApi` in Phase 0.
- Treat command/file approvals as server-initiated requests and wait for `serverRequest/resolved`; never auto-approve.
- `thread/list` defaults to non-archived interactive sources, so the read-only probe explicitly checks active and archived pages and records the accepted `sourceKinds` from generated schema.
- Windows currently reports `codex app-server daemon` lifecycle as unsupported. The harness tests stdio candidates and does not assume a daemon/control socket exists.

Reference: [Codex App Server documentation](https://developers.openai.com/codex/app-server/).

## File map

```text
package.json                                      Node scripts and test commands
.gitignore                                        Generated schemas, reports, and secrets
src/cli.js                                        Argument parsing and probe orchestration
src/orchestrator.js                               Fixed probe order and failure isolation
src/report/model.js                               Gate/status model and phase evaluator
src/report/write-report.js                        Atomic JSON/Markdown evidence writer
src/windows/inventory.js                          PowerShell inventory adapter
scripts/windows/inventory.ps1                     Package, Start App, process, and CLI discovery
scripts/windows/activate-codex.ps1                 Explicitly authorized Store activation probe
src/process/run-command.js                        Safe executable/.cmd process runner
src/app-server/candidates.js                      Candidate ranking and binary identity
src/app-server/schema-contract.js                 Fail-closed stable enum extraction
src/app-server/jsonl-peer.js                      Bidirectional JSONL request/notification transport
src/app-server/probe-readonly.js                  Initialize, schema, account, and thread listing probe
src/cdp/port-probe.js                             Loopback DevTools discovery and read-only attach
src/cdp/pipe-probe.js                             Direct remote-debugging-pipe capability probe
scripts/probes/fake-cdp-pipe-child.mjs            Deterministic pipe fixture
scripts/probes/cdp-port-attack.mjs                 Separate-process proof that CDP port has no auth
src/security/local-api.js                         Minimal guarded loopback server
src/journal/dispatch-journal.js                    SQLite at-most-once dispatch state machine
src/approvals/approval-store.js                    Approval digest, expiry, and responder checks
src/live/live-probes.js                            Opt-in visibility, approval, and double-start probes
fixtures/windows/inventory.json                   Unit-test Windows inventory
tests/unit/*.test.js                               Deterministic tests without Codex mutation
tests/integration/*.test.js                        Local process/network integration tests
docs/phase-0-runbook.md                            Consent, commands, interpretation, cleanup
artifacts/phase-0/<run-id>/report.json             Ignored machine-readable result
artifacts/phase-0/<run-id>/summary.md              Ignored human-readable result
```

## Safety contract

- Default command is `readonly`; it may inspect installed binaries, hash files, generate schemas in `artifacts/`, list thread metadata, and test a temporary localhost server.
- `--allow-codex-restart` only activates Codex with debugging arguments after the user has manually closed all existing Codex windows. It never kills a process.
- `--probe-existing-instance` activates the same AUMID while Codex is already open to measure whether the single-instance handoff preserves or discards debugging arguments. It never closes the existing process.
- `--allow-persistent-thread` creates exactly one clearly named probe thread and prints its ID. It never archives or deletes that thread.
- `--allow-model-turns` permits the approval and double-start probes and may consume Codex quota. It is rejected unless `--allow-persistent-thread` is also present.
- Approval probes always answer `decline`; no file or network action is approved.
- A sent-but-unconfirmed dispatch becomes `unknown` after restart and is never replayed automatically.
- Reports redact bearer tokens, bootstrap nonces, prompts beyond fixed probe identifiers, and full thread content.

### Task 1: Scaffold the harness and phase evaluator

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/report/model.js`
- Test: `tests/unit/report-model.test.js`

- [ ] **Step 1: Write the failing phase-evaluation test**

```js
// tests/unit/report-model.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePhases, GATE_IDS } from "../../src/report/model.js";

const result = (id, status) => ({ id, status, evidence: [], notes: [] });

test("read-only remains viable when injection is no-go", () => {
  const gates = GATE_IDS.map((id) => result(id, "pass"));
  gates.find((gate) => gate.id === "secure_injection").status = "fail";
  assert.deepEqual(evaluatePhases(gates), {
    standalonePhase1: "go",
    injectedPhase1: "no-go",
    phase2: "no-go",
    phase3: "blocked-by-git-gate",
  });
});

test("App Server identity failure blocks execution", () => {
  const gates = GATE_IDS.map((id) => result(id, "pass"));
  gates.find((gate) => gate.id === "app_server_identity").status = "fail";
  assert.equal(evaluatePhases(gates).standalonePhase1, "go-with-readonly-degradation");
  assert.equal(evaluatePhases(gates).phase2, "no-go");
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `node --test tests/unit/report-model.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/report/model.js`.

- [ ] **Step 3: Add package metadata, ignore rules, and evaluator**

```json
{
  "name": "codex-projectboard-phase0",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "test": "node --test",
    "test:unit": "node --test tests/unit/*.test.js",
    "test:integration": "node --test tests/integration/*.test.js",
    "probe": "node src/cli.js readonly",
    "probe:live": "node src/cli.js live"
  }
}
```

```gitignore
artifacts/
node_modules/
src/app-server/generated/
*.token
*.nonce
```

```js
// src/report/model.js
export const GATE_IDS = Object.freeze([
  "windows_inventory", "secure_injection", "app_server_identity",
  "approval_lifecycle", "double_write_control", "dispatch_recovery", "local_api_security",
]);
export const EXECUTION_GATE_IDS = Object.freeze([
  "secure_injection", "app_server_identity", "approval_lifecycle",
  "double_write_control", "dispatch_recovery", "local_api_security",
]);

const passed = (gates, id) => gates.some((gate) => gate.id === id && gate.status === "pass");

export function evaluatePhases(gates) {
  const standalonePhase1 = passed(gates, "app_server_identity") ? "go" : "go-with-readonly-degradation";
  const injectedPhase1 = passed(gates, "secure_injection") ? "go" : "no-go";
  const phase2 = EXECUTION_GATE_IDS.every((id) => passed(gates, id)) ? "go" : "no-go";
  return { standalonePhase1, injectedPhase1, phase2, phase3: "blocked-by-git-gate" };
}
```

- [ ] **Step 4: Run evaluator tests**

Run: `npm.cmd run test:unit`

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Commit the scaffold**

```powershell
git add package.json .gitignore src/report/model.js tests/unit/report-model.test.js
git commit -m "test: scaffold phase zero compatibility harness"
```

### Task 2: Inventory the Windows Codex installation without assumptions

**Files:**
- Create: `scripts/windows/inventory.ps1`
- Create: `src/windows/inventory.js`
- Create: `fixtures/windows/inventory.json`
- Test: `tests/unit/windows-inventory.test.js`

- [ ] **Step 1: Write the inventory parser test and fixture**

```json
{
  "package": { "name": "OpenAI.Codex", "packageFamilyName": "OpenAI.Codex_2p2nqsd0c76g0", "version": "26.730.8199.0", "installLocation": "C:\\Program Files\\WindowsApps\\OpenAI.Codex" },
  "startApps": [{ "name": "Codex", "appId": "OpenAI.Codex_2p2nqsd0c76g0!App" }],
  "processes": [{ "pid": 1200, "name": "ChatGPT", "path": null }],
  "commands": [{ "kind": "Application", "name": "codex.cmd", "source": "E:\\DevTools\\npm-global\\codex.cmd" }],
  "errors": ["process-path: access denied"]
}
```

```js
// tests/unit/windows-inventory.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseInventory } from "../../src/windows/inventory.js";

test("inventory keeps uncertainty instead of inventing paths", async () => {
  const raw = JSON.parse(await readFile("fixtures/windows/inventory.json", "utf8"));
  const value = parseInventory(raw);
  assert.equal(value.package.name, "OpenAI.Codex");
  assert.equal(value.processes[0].path, null);
  assert.deepEqual(value.errors, ["process-path: access denied"]);
});
```

- [ ] **Step 2: Run the parser test and verify failure**

Run: `node --test tests/unit/windows-inventory.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the collector and parser**

```powershell
# scripts/windows/inventory.ps1
$ErrorActionPreference = 'Stop'
$errors = [System.Collections.Generic.List[string]]::new()
$package = $null
try { $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | Select-Object -First 1 Name,PackageFamilyName,Version,InstallLocation }
catch { $errors.Add("package: $($_.Exception.Message)") }
$startApps = @()
try { $startApps = @(Get-StartApps | Where-Object { $_.AppID -like '*OpenAI.Codex*' -or $_.Name -match 'Codex|ChatGPT' } | ForEach-Object { [ordered]@{ name=$_.Name; appId=$_.AppID } }) }
catch { $errors.Add("start-apps: $($_.Exception.Message)") }
$processes = @()
foreach ($name in @('ChatGPT','Codex')) {
  foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
    $path = $null
    try { $path = $process.Path } catch { $errors.Add("process-path: $($_.Exception.Message)") }
    $processes += [ordered]@{ pid=$process.Id; name=$process.ProcessName; path=$path }
  }
}
$commands = @(Get-Command codex.exe,codex.cmd -All -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ kind=$_.CommandType.ToString(); name=$_.Name; source=$_.Source } })
[ordered]@{
  package = if ($package) { [ordered]@{ name=$package.Name; packageFamilyName=$package.PackageFamilyName; version=$package.Version.ToString(); installLocation=$package.InstallLocation } } else { $null }
  startApps=$startApps; processes=$processes; commands=$commands; errors=@($errors)
} | ConvertTo-Json -Depth 8 -Compress
```

```js
// src/windows/inventory.js
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export function parseInventory(raw) {
  if (!raw || !Array.isArray(raw.startApps) || !Array.isArray(raw.commands) || !Array.isArray(raw.errors)) throw new TypeError("Invalid Windows inventory payload");
  return { package: raw.package ?? null, startApps: raw.startApps, processes: Array.isArray(raw.processes) ? raw.processes : [], commands: raw.commands, errors: raw.errors.map(String) };
}

export async function collectWindowsInventory() {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/windows/inventory.ps1"], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return parseInventory(JSON.parse(stdout.trim()));
}
```

- [ ] **Step 4: Run unit and real read-only inventory tests**

Run: `npm.cmd run test:unit`

Expected: 3 tests pass, 0 fail.

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/inventory.ps1`

Expected: one JSON object. Access failures remain in `errors` instead of being guessed.

- [ ] **Step 5: Commit Windows discovery**

```powershell
git add scripts/windows/inventory.ps1 src/windows/inventory.js fixtures/windows/inventory.json tests/unit/windows-inventory.test.js
git commit -m "feat: inventory Windows Codex identities"
```

### Task 3: Select and fingerprint App Server candidates

**Files:**
- Create: `src/process/run-command.js`
- Create: `src/app-server/candidates.js`
- Create: `src/app-server/schema-contract.js`
- Create: `scripts/generate-app-server-schema.mjs`
- Test: `tests/unit/app-server-candidates.test.js`

- [ ] **Step 1: Write candidate ranking tests**

```js
// tests/unit/app-server-candidates.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { fingerprintCandidates, rankCandidates } from "../../src/app-server/candidates.js";
import { extractThreadSourceKinds } from "../../src/app-server/schema-contract.js";

test("accessible package helper outranks global CLI", () => {
  const ranked = rankCandidates([
    { path: "E:\\DevTools\\npm-global\\codex.cmd", origin: "global", accessible: true },
    { path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\resources\\codex.exe", origin: "package", accessible: true },
  ]);
  assert.equal(ranked[0].origin, "package");
});

test("inaccessible package helper remains evidence but is not selected", () => {
  const ranked = rankCandidates([
    { path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\resources\\codex.exe", origin: "package", accessible: false },
    { path: "E:\\DevTools\\npm-global\\codex.cmd", origin: "global", accessible: true },
  ]);
  assert.equal(ranked[0].origin, "global");
  assert.equal(ranked[1].accessible, false);
});

test("thread source kinds come from the selected binary schema", () => {
  const schema={properties:{sourceKinds:{items:{$ref:"#/definitions/ThreadSourceKind"}}},definitions:{ThreadSourceKind:{type:"string",enum:["cli","appServer","subAgent"]}}};
  assert.deepEqual(extractThreadSourceKinds(schema),["cli","appServer","subAgent"]);
  assert.throws(()=>extractThreadSourceKinds({properties:{},definitions:{}}),/sourceKinds/);
});

test("every accessible candidate is fingerprinted and version drift remains visible", async () => {
  const candidates=[{path:"package.exe",origin:"package",accessible:true},{path:"codex.cmd",origin:"global",accessible:true},{path:"denied.exe",origin:"package",accessible:false}];
  const rows=await fingerprintCandidates(candidates,{run:async(path)=>({code:0,stdout:path==="package.exe"?"codex 1.0":"codex 2.0",stderr:""}),hash:async(path)=>`hash:${path}`});
  assert.deepEqual(rows.map(({version,sha256})=>[version,sha256]),[["codex 1.0","hash:package.exe"],["codex 2.0","hash:codex.cmd"],[null,null]]);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/unit/app-server-candidates.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement process execution, ranking, hashing, and schema generation**

```js
// src/process/run-command.js
import { spawn } from "node:child_process";
export function spawnCommand(executable, args, options = {}) {
  const isCmd = process.platform === "win32" && executable.toLowerCase().endsWith(".cmd");
  return isCmd
    ? spawn(process.env.ComSpec, ["/d", "/s", "/c", "call", executable, ...args], { windowsHide: true, ...options })
    : spawn(executable, args, { windowsHide: true, ...options });
}
export function runCommand(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(executable, args, options);
    let stdout = ""; let stderr = "";
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; }); child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
```

```js
// src/app-server/candidates.js
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../process/run-command.js";
export function rankCandidates(candidates) {
  const score = (candidate) => (candidate.accessible ? 100 : 0) + (candidate.origin === "package" ? 20 : 10);
  return [...candidates].sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
}
export async function sha256File(filePath) { return createHash("sha256").update(await readFile(filePath)).digest("hex"); }
export async function fingerprintCandidates(candidates,{run=runCommand,hash=sha256File}={}) {
  const rows=[];
  for(const candidate of candidates){
    if(!candidate.accessible){rows.push({...candidate,version:null,sha256:null,fingerprintError:"inaccessible"});continue;}
    try{const version=await run(candidate.path,["--version"]);if(version.code!==0)throw new Error(version.stderr||"version failed");rows.push({...candidate,version:version.stdout.trim(),sha256:await hash(candidate.path),fingerprintError:null});}
    catch(error){rows.push({...candidate,version:null,sha256:null,fingerprintError:error.message});}
  }
  return rows;
}
export async function discoverCandidates(inventory) {
  const raw = inventory.commands.map((command) => ({ path:command.source, origin:"global" }));
  if (inventory.package?.installLocation) raw.push({ path:path.join(inventory.package.installLocation,"app","resources","codex.exe"), origin:"package" });
  const checked = await Promise.all(raw.map(async (candidate) => ({ ...candidate, accessible:await access(candidate.path).then(()=>true,()=>false) })));
  return rankCandidates(checked);
}
```

```js
// src/app-server/schema-contract.js
import { readFile } from "node:fs/promises";
import path from "node:path";
export function extractThreadSourceKinds(schema) {
  const ref=schema.properties?.sourceKinds?.items?.$ref;
  const name=ref?.split("/").at(-1);
  const values=name?schema.definitions?.[name]?.enum:null;
  if(!Array.isArray(values)||values.length===0||values.some((value)=>typeof value!=="string")) throw new Error("selected schema has no stable sourceKinds enum");
  return [...values];
}
export async function readThreadSourceKinds(schemaDirectory) {
  const schema=JSON.parse(await readFile(path.join(schemaDirectory,"v2","ThreadListParams.json"),"utf8"));
  return extractThreadSourceKinds(schema);
}
```

```js
// scripts/generate-app-server-schema.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { runCommand } from "../src/process/run-command.js";
import { sha256File } from "../src/app-server/candidates.js";
import { readThreadSourceKinds } from "../src/app-server/schema-contract.js";
const [binary, output] = process.argv.slice(2);
if (!binary || !output) throw new Error("Usage: node scripts/generate-app-server-schema.mjs <binary> <output>");
await mkdir(output, { recursive: true });
const version = await runCommand(binary, ["--version"]);
if (version.code !== 0) throw new Error(version.stderr || "codex --version failed");
const generated = await runCommand(binary, ["app-server", "generate-json-schema", "--out", output]);
if (generated.code !== 0) throw new Error(generated.stderr || "schema generation failed");
const sourceKinds=await readThreadSourceKinds(output);
await writeFile(`${output}/binary-manifest.json`, JSON.stringify({ binary, version: version.stdout.trim(), sha256: await sha256File(binary), sourceKinds }, null, 2));
```

- [ ] **Step 4: Run unit tests and generate a schema**

Run: `npm.cmd run test:unit`

Expected: 7 tests pass, 0 fail.

Run:

```powershell
$codexBinary = (Get-Command codex.cmd -ErrorAction Stop).Source
node scripts/generate-app-server-schema.mjs $codexBinary "artifacts\phase-0\manual-schema"
```

Expected: exit 0 with generated schemas and `binary-manifest.json`. Use the exact discovered path when it differs.

- [ ] **Step 5: Commit candidate handling**

```powershell
git add src/process/run-command.js src/app-server/candidates.js src/app-server/schema-contract.js scripts/generate-app-server-schema.mjs tests/unit/app-server-candidates.test.js
git commit -m "feat: fingerprint App Server candidates"
```

### Task 4: Implement the bidirectional JSONL client and read-only protocol probe

**Files:**
- Create: `src/app-server/jsonl-peer.js`
- Create: `src/app-server/probe-readonly.js`
- Test: `tests/unit/jsonl-peer.test.js`
- Test: `tests/integration/app-server-readonly.test.js`

- [ ] **Step 1: Write transport tests for responses and server requests**

```js
// tests/unit/jsonl-peer.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { JsonlPeer } from "../../src/app-server/jsonl-peer.js";

test("peer separates responses from server requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonlPeer({ input, output });
  const serverRequests = [];
  peer.on("serverRequest", (message) => serverRequests.push(message));
  const pending = peer.request("thread/list", { limit: 1 });
  input.write(`${JSON.stringify({ id: 1, result: { data: [], nextCursor: null } })}\n`);
  input.write(`${JSON.stringify({ id: 91, method: "item/commandExecution/requestApproval", params: { threadId: "thr", turnId: "turn", itemId: "item" } })}\n`);
  assert.deepEqual(await pending, { data: [], nextCursor: null });
  assert.equal(serverRequests[0].id, 91);
  assert.equal(output.read().toString().includes('"method":"thread/list"'), true);
  const rejected=peer.request("turn/start",{});
  input.write(`${JSON.stringify({id:2,error:{code:-32000,message:"thread busy",data:{reason:"activeTurn"}}})}\n`);
  await assert.rejects(rejected,(error)=>error.rpc.code===-32000&&error.rpc.data.reason==="activeTurn");
  assert.deepEqual(peer.outbound.filter((message)=>message.method).map((message)=>message.method),["thread/list","turn/start"]);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `node --test tests/unit/jsonl-peer.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement JSONL framing, handshake, and pagination**

```js
// src/app-server/jsonl-peer.js
import { EventEmitter } from "node:events";
import readline from "node:readline";

export class JsonlPeer extends EventEmitter {
  #nextId = 1;
  #pending = new Map();
  #output;
  outbound = [];
  notifications = [];
  serverRequests = [];
  constructor({ input, output }) {
    super();
    this.#output = output;
    const lines = readline.createInterface({ input });
    lines.on("line", (line) => { try { this.#receive(JSON.parse(line)); } catch(error) { this.emit("protocolError",error); this.#failAll(error); } });
    lines.on("close", () => this.#failAll(new Error("App Server transport closed")));
  }
  request(method, params = {}, timeoutMs = 15000) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer=setTimeout(()=>{this.#pending.delete(id);reject(new Error(`${method} timed out`));},timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ method, id, params });
    });
  }
  notify(method, params = {}) { this.#send({ method, params }); }
  respond(id, result) { this.#send({ id, result }); }
  #send(message) { this.outbound.push(structuredClone(message)); this.#output.write(`${JSON.stringify(message)}\n`); }
  #receive(message) {
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return this.emit("orphanResponse", message);
      this.#pending.delete(message.id); clearTimeout(pending.timer);
      return message.error ? pending.reject(Object.assign(new Error(message.error.message), { rpc: message.error })) : pending.resolve(message.result);
    }
    if (Object.hasOwn(message, "id") && message.method) { this.serverRequests.push(message); return this.emit("serverRequest", message); }
    this.notifications.push(message); this.emit("notification", message);
  }
  #failAll(error) { for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.#pending.clear(); }
}
```

```js
// src/app-server/probe-readonly.js
import { spawnCommand } from "../process/run-command.js";
import { JsonlPeer } from "./jsonl-peer.js";

export async function openAppServer(binary) {
  const child = spawnCommand(binary, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const peer = new JsonlPeer({ input: child.stdout, output: child.stdin });
  const initialized = await initializeStable(peer);
  return { child, peer, initialized };
}

export async function initializeStable(peer) {
  const result = await peer.request("initialize", { clientInfo: { name: "codex_projectboard_phase0", title: "Codex Projectboard Phase 0", version: "0.1.0" } });
  peer.notify("initialized", {});
  return result;
}

export async function listAllThreadMetadata(peer, archived, sourceKinds) {
  if(!Array.isArray(sourceKinds)||sourceKinds.length===0) throw new Error("generated sourceKinds are required");
  const rows = [];
  let cursor = null;
  do {
    const page = await peer.request("thread/list", { cursor, limit: 100, sortKey: "updated_at", sortDirection: "desc", archived, sourceKinds });
    rows.push(...page.data.map(({ id, name, preview, cwd, createdAt, updatedAt, status }) => ({ id, name, preview, cwd, createdAt, updatedAt, status })));
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

export async function probeAppServerIdentity(binary, sourceKinds) {
  const { child, peer, initialized } = await openAppServer(binary);
  try {
    const account = await peer.request("account/read", { refreshToken:false });
    const active = await listAllThreadMetadata(peer, false, sourceKinds);
    const archived = await listAllThreadMetadata(peer, true, sourceKinds);
    return { initialized, accountType:account.account?.type??null, requiresOpenaiAuth:account.requiresOpenaiAuth, activeCount:active.length, archivedCount:archived.length };
  } finally { child.kill(); }
}
```

```js
// tests/integration/app-server-readonly.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { openAppServer, listAllThreadMetadata } from "../../src/app-server/probe-readonly.js";
import { readThreadSourceKinds } from "../../src/app-server/schema-contract.js";

const binary = process.env.PROJECTBOARD_CODEX_BINARY;
const schemaDirectory = process.env.PROJECTBOARD_SCHEMA_DIR;
test("selected App Server lists metadata through stable API", { skip: !binary||!schemaDirectory }, async (t) => {
  const { child, peer, initialized } = await openAppServer(binary);
  t.after(() => child.kill());
  const sourceKinds=await readThreadSourceKinds(schemaDirectory);
  assert.equal(typeof initialized, "object");
  const active = await listAllThreadMetadata(peer, false, sourceKinds);
  const archived = await listAllThreadMetadata(peer, true, sourceKinds);
  assert.equal(Array.isArray(active), true);
  assert.equal(Array.isArray(archived), true);
  const methods=peer.outbound.filter((message)=>message.method).map((message)=>message.method);
  assert.equal(methods.includes("initialize"),true);
  assert.equal(methods.filter((method)=>method==="thread/list").length>=2,true);
  assert.equal(methods.some((method)=>new Set(["thread/read","thread/start","thread/archive","thread/delete"]).has(method)),false);
});
```

- [ ] **Step 4: Run unit tests, then the read-only integration test**

Run: `npm.cmd run test:unit`

Expected: 8 tests pass, 0 fail.

Run:

```powershell
$env:PROJECTBOARD_CODEX_BINARY = (Get-Command codex.cmd -ErrorAction Stop).Source
$env:PROJECTBOARD_SCHEMA_DIR = (Resolve-Path "artifacts\phase-0\manual-schema").Path
node --test tests/integration/app-server-readonly.test.js
```

Expected: PASS when `PROJECTBOARD_CODEX_BINARY` identifies the selected candidate. The test emits initialize, initialized, active list, and archived list only; it asserts that no full read, start, archive, or delete method is sent.

- [ ] **Step 5: Commit the protocol client**

```powershell
git add src/app-server/jsonl-peer.js src/app-server/probe-readonly.js tests/unit/jsonl-peer.test.js tests/integration/app-server-readonly.test.js
git commit -m "feat: probe App Server over JSONL"
```

### Task 5: Probe CDP pipe and port modes without bypassing CSP

**Files:**
- Create: `src/cdp/port-probe.js`
- Create: `src/cdp/pipe-probe.js`
- Create: `scripts/probes/fake-cdp-pipe-child.mjs`
- Create: `scripts/probes/cdp-port-attack.mjs`
- Create: `scripts/windows/activate-codex.ps1`
- Test: `tests/unit/cdp-targets.test.js`
- Test: `tests/integration/cdp-pipe.test.js`

- [ ] **Step 1: Write target-selection and pipe-framing tests**

```js
// tests/unit/cdp-targets.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { selectCodexTargets, evaluateDocumentTitle } from "../../src/cdp/port-probe.js";

test("selects every page target with an app URL and no foreign target", () => {
  const targets = selectCodexTargets([
    { id: "worker", type: "worker", url: "app://codex/background" },
    { id: "foreign", type: "page", url: "https://example.com" },
    { id: "codex", type: "page", url: "app://codex/index.html", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/codex" },
    { id: "codex-2", type: "page", url: "app://codex/second.html", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/codex-2" },
  ]);
  assert.deepEqual(targets.map((target)=>target.id),["codex","codex-2"]);
});

test("port attack can issue a read-only Runtime.evaluate", async () => {
  class FakeSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send() { queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 1, result: { result: { value: "Codex" } } }) }))); }
    close() {}
  }
  assert.equal(await evaluateDocumentTitle("ws://fixture", FakeSocket), "Codex");
});
```

```js
// tests/integration/cdp-pipe.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { probeDirectPipe } from "../../src/cdp/pipe-probe.js";

test("remote debugging pipe uses NUL-delimited messages", async () => {
  const result = await probeDirectPipe(process.execPath, ["scripts/probes/fake-cdp-pipe-child.mjs"]);
  assert.equal(result.product, "FakeCodex/1.0");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/unit/cdp-targets.test.js tests/integration/cdp-pipe.test.js`

Expected: FAIL with missing CDP modules.

- [ ] **Step 3: Implement read-only CDP probes and Store activation**

```js
// src/cdp/port-probe.js
import net from "node:net";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import path from "node:path";
import { probePipeInjection } from "./pipe-probe.js";
const execFileAsync=promisify(execFile);
export function selectCodexTargets(targets) {
  const matches = targets.filter((target) => target.type === "page" && /^app:\/\//.test(target.url));
  if (matches.length === 0) throw new Error("No Codex page target found");
  return matches.sort((a,b)=>a.id.localeCompare(b.id));
}
export async function probePort(port, fetchImpl = fetch) {
  const origin = `http://127.0.0.1:${port}`;
  const version = await (await fetchImpl(`${origin}/json/version`)).json();
  const targets = selectCodexTargets(await (await fetchImpl(`${origin}/json/list`)).json());
  return { transport: "port", browser: version.Browser, targets };
}

export function evaluateExpression(webSocketUrl, expression, WebSocketImpl = WebSocket) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(webSocketUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error("CDP websocket timeout")); }, 5000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer); socket.close();
      if(message.error)return reject(Object.assign(new Error(message.error.message),{rpc:message.error}));
      if(message.result?.exceptionDetails)return reject(new Error(message.result.exceptionDetails.text??"Runtime.evaluate failed"));
      resolve(message.result?.result?.value);
    });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket failed")); });
  });
}

export function evaluateDocumentTitle(webSocketUrl, WebSocketImpl = WebSocket) {
  return evaluateExpression(webSocketUrl,"document.title",WebSocketImpl);
}

async function reservePort() {
  const server=net.createServer();
  await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve));
  const port=server.address().port;
  await new Promise((resolve)=>server.close(resolve));
  return port;
}

export async function probePortInjection(appUserModelId) {
  const port=await reservePort();
  const ui=http.createServer((request,response)=>{response.writeHead(200,{"content-type":"text/html","content-security-policy":"default-src 'none'"});response.end("<!doctype html><title>Projectboard Phase 0</title>");});
  await new Promise((resolve)=>ui.listen(0,"127.0.0.1",resolve));
  const uiUrl=`http://127.0.0.1:${ui.address().port}/ui`;
  try {
    await execFileAsync("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File","scripts/windows/activate-codex.ps1","-AppUserModelId",appUserModelId,"-Arguments",`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`],{windowsHide:true});
    let result;
    for(let attempt=0;attempt<40;attempt+=1){
      try { result=await probePort(port); break; }
      catch { await new Promise((resolve)=>setTimeout(resolve,500)); }
    }
    if(!result)return {status:"fail",mode:"port",reason:"endpoint unavailable"};
    const mountExpression=`new Promise((resolve)=>{const old=document.getElementById('projectboard-phase0-frame');if(old)old.remove();const frame=document.createElement('iframe');frame.id='projectboard-phase0-frame';frame.onload=()=>resolve('loaded');frame.onerror=()=>resolve('error');frame.src=${JSON.stringify(uiUrl)};document.body.append(frame);setTimeout(()=>resolve('timeout'),3000);})`;
    const mounts=[];
    for(const target of result.targets){
      const first=await evaluateExpression(target.webSocketDebuggerUrl,mountExpression); const second=await evaluateExpression(target.webSocketDebuggerUrl,mountExpression);
      const count=await evaluateExpression(target.webSocketDebuggerUrl,"document.querySelectorAll('#projectboard-phase0-frame').length");
      await evaluateExpression(target.webSocketDebuggerUrl,"document.getElementById('projectboard-phase0-frame')?.remove(); true");
      mounts.push({targetId:target.id,first,second,count});
    }
    const attack=await execFileAsync(process.execPath,["scripts/probes/cdp-port-attack.mjs",String(port)],{windowsHide:true}); const attackResult=JSON.parse(attack.stdout);
    const mountWithoutBypass=mounts.every((mount)=>mount.first==="loaded"&&mount.second==="loaded"&&mount.count===1);
    return {status:"fail",mode:"port",port,targetIds:result.targets.map((target)=>target.id),mountWithoutBypass,idempotent:mounts.every((mount)=>mount.count===1),unauthenticatedAttach:attackResult.unauthenticatedAttach,transportRisk:"same-user-local-process-can-control-renderer"};
  } finally {
    await new Promise((resolve)=>ui.close(()=>resolve()));
  }
}

export async function probeSecureInjection(inventory) {
  const gui=inventory.package?.installLocation?path.join(inventory.package.installLocation,"app","ChatGPT.exe"):null;
  if(gui&&await access(gui).then(()=>true,()=>false)){
    try { return await probePipeInjection(gui,["--remote-debugging-pipe"]); }
    catch(error) { const portResult=await probePortInjection(inventory.startApps[0].appId); return {...portResult,pipeFailure:error.message}; }
  }
  const portResult=await probePortInjection(inventory.startApps[0].appId);
  return {...portResult,pipeFailure:"direct GUI executable unavailable"};
}
```

```js
// src/cdp/pipe-probe.js
import { spawn } from "node:child_process";
import http from "node:http";

class CdpPipePeer {
  #nextId=1; #pending=new Map(); #input; #output; #buffer=Buffer.alloc(0);
  constructor(input,output,child){
    this.#input=input; this.#output=output;
    output.on("data",(chunk)=>this.#receive(chunk));
    const fail=(error)=>{for(const pending of this.#pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.#pending.clear();};
    input.on("error",fail); output.on("error",fail); child.once("error",fail); child.once("close",()=>fail(new Error("CDP pipe closed")));
  }
  request(method,params={},sessionId=null,timeoutMs=10000){
    const id=this.#nextId++; const message={id,method,params}; if(sessionId)message.sessionId=sessionId;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.#pending.delete(id);reject(new Error(`${method} timed out`));},timeoutMs);this.#pending.set(id,{resolve,reject,timer});this.#input.write(`${JSON.stringify(message)}\0`);});
  }
  #receive(chunk){
    this.#buffer=Buffer.concat([this.#buffer,chunk]);
    for(let end=this.#buffer.indexOf(0);end>=0;end=this.#buffer.indexOf(0)){
      const frame=this.#buffer.subarray(0,end); this.#buffer=this.#buffer.subarray(end+1); if(frame.length===0)continue;
      const message=JSON.parse(frame.toString("utf8")); const pending=this.#pending.get(message.id); if(!pending)continue;
      this.#pending.delete(message.id); clearTimeout(pending.timer);
      if(message.error)pending.reject(Object.assign(new Error(message.error.message),{rpc:message.error})); else pending.resolve(message.result);
    }
  }
  close(){this.#input.end();this.#output.destroy();}
}

function openDirectPipe(executable,args){
  const child=spawn(executable,args,{stdio:["ignore","ignore","ignore","pipe","pipe"],windowsHide:true});
  return {child,peer:new CdpPipePeer(child.stdio[3],child.stdio[4],child)};
}

export async function probeDirectPipe(executable,args){
  const {peer}=openDirectPipe(executable,args);
  try{return await peer.request("Browser.getVersion");}finally{peer.close();}
}

export async function probePipeInjection(executable,args){
  const ui=http.createServer((request,response)=>{response.writeHead(200,{"content-type":"text/html","content-security-policy":"default-src 'none'"});response.end("<!doctype html><title>Projectboard Phase 0</title>");});
  await new Promise((resolve)=>ui.listen(0,"127.0.0.1",resolve)); const uiUrl=`http://127.0.0.1:${ui.address().port}/ui`;
  const {peer}=openDirectPipe(executable,args);
  try{
    const version=await peer.request("Browser.getVersion"); let targets=[];
    for(let attempt=0;attempt<40;attempt+=1){const result=await peer.request("Target.getTargets");targets=result.targetInfos.filter((target)=>target.type==="page"&&/^app:\/\//.test(target.url));if(targets.length>0)break;await new Promise((resolve)=>setTimeout(resolve,500));}
    if(targets.length===0)throw new Error("no app renderer on debugging pipe");
    const expression=`new Promise((resolve)=>{const old=document.getElementById('projectboard-phase0-frame');if(old)old.remove();const frame=document.createElement('iframe');frame.id='projectboard-phase0-frame';frame.onload=()=>resolve('loaded');frame.onerror=()=>resolve('error');frame.src=${JSON.stringify(uiUrl)};document.body.append(frame);setTimeout(()=>resolve('timeout'),3000);})`;
    const mounts=[];
    for(const target of targets){
      const {sessionId}=await peer.request("Target.attachToTarget",{targetId:target.targetId,flatten:true});
      const evaluate=(code)=>peer.request("Runtime.evaluate",{expression:code,awaitPromise:true,returnByValue:true},sessionId);
      const first=await evaluate(expression); const second=await evaluate(expression); const count=await evaluate("document.querySelectorAll('#projectboard-phase0-frame').length");
      await evaluate("document.getElementById('projectboard-phase0-frame')?.remove(); true");
      mounts.push({targetId:target.targetId,first:first.result?.value,second:second.result?.value,count:count.result?.value,exceptions:[first.exceptionDetails??null,second.exceptionDetails??null]});
    }
    const pass=mounts.every((mount)=>mount.first==="loaded"&&mount.second==="loaded"&&mount.count===1&&mount.exceptions.every((value)=>value===null));
    return {status:pass?"pass":"fail",mode:"pipe",product:version.product,targetIds:targets.map((target)=>target.targetId),mountWithoutBypass:pass,idempotent:mounts.every((mount)=>mount.count===1),mounts};
  }finally{peer.close();await new Promise((resolve)=>ui.close(()=>resolve()));}
}
```

```js
// scripts/probes/fake-cdp-pipe-child.mjs
import { createReadStream, createWriteStream } from "node:fs";
let bytes = Buffer.alloc(0);
const input = createReadStream(null, { fd: 3, autoClose: false });
const output = createWriteStream(null, { fd: 4, autoClose: false });
input.on("data", (chunk) => {
  bytes = Buffer.concat([bytes, chunk]);
  if (bytes.indexOf(0) >= 0) output.end(`${JSON.stringify({ id: 1, result: { product: "FakeCodex/1.0" } })}\0`,()=>process.exit(0));
});
```

```js
// scripts/probes/cdp-port-attack.mjs
import { probePort, evaluateDocumentTitle } from "../../src/cdp/port-probe.js";
const port = Number(process.argv[2]);
if (!Number.isInteger(port)) throw new Error("port required");
const probe = await probePort(port); const target=probe.targets[0];
const title = await evaluateDocumentTitle(target.webSocketDebuggerUrl);
process.stdout.write(JSON.stringify({ unauthenticatedAttach: true, targetId: target.id, titleLength: String(title).length }));
```

The live port probe runs `cdp-port-attack.mjs` as a separate process. If it evaluates `document.title` without a credential, the report records `transportRisk: "same-user-local-process-can-control-renderer"`; random loopback port selection must not convert that result to secure.

```powershell
# scripts/windows/activate-codex.ps1
param([Parameter(Mandatory=$true)][string]$AppUserModelId,[Parameter(Mandatory=$true)][string]$Arguments,[switch]$DryRun)
if ($DryRun) { [ordered]@{appUserModelId=$AppUserModelId;arguments=$Arguments;activated=$false}|ConvertTo-Json -Compress; exit 0 }
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[Flags] public enum ActivateOptions { None = 0 }
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
  [PreserveSig]
  int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,[MarshalAs(UnmanagedType.LPWStr)] string arguments,ActivateOptions options,out uint processId);
  [PreserveSig]
  int ActivateForFile(IntPtr appUserModelId,IntPtr itemArray,IntPtr verb,out uint processId);
  [PreserveSig]
  int ActivateForProtocol(IntPtr appUserModelId,IntPtr itemArray,out uint processId);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] public class ApplicationActivationManager {}
'@
$manager = [IApplicationActivationManager][ApplicationActivationManager]::new()
$processId = 0
$hresult = $manager.ActivateApplication($AppUserModelId,$Arguments,[ActivateOptions]::None,[ref]$processId)
if ($hresult -ne 0) { [Runtime.InteropServices.Marshal]::ThrowExceptionForHR($hresult) }
[ordered]@{appUserModelId=$AppUserModelId;arguments=$Arguments;activated=$true;pid=$processId}|ConvertTo-Json -Compress
```

The live orchestrator declares pipe support only after it discovers every `app://` page through the inherited descriptors, mounts the iframe twice on the same pipe connection, observes exactly one mounted frame per renderer, and removes it. Port mode is always an explicit security downgrade even when its CSP mount succeeds. No code path sends `Page.setBypassCSP`.

- [ ] **Step 4: Run tests and activation dry run**

Run: `node --test tests/unit/cdp-targets.test.js tests/integration/cdp-pipe.test.js`

Expected: 3 tests pass, 0 fail.

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/activate-codex.ps1 -AppUserModelId "OpenAI.Codex_2p2nqsd0c76g0!App" -Arguments "--remote-debugging-port=0" -DryRun`

Expected: JSON with `activated:false`; no process is started or stopped.

- [ ] **Step 5: Commit CDP probes**

```powershell
git add src/cdp scripts/probes/fake-cdp-pipe-child.mjs scripts/probes/cdp-port-attack.mjs scripts/windows/activate-codex.ps1 tests/unit/cdp-targets.test.js tests/integration/cdp-pipe.test.js
git commit -m "feat: probe safe Codex debugging transports"
```

### Task 6: Prove localhost API authentication and replay resistance

**Files:**
- Create: `src/security/local-api.js`
- Test: `tests/integration/local-api-security.test.js`

- [ ] **Step 1: Write attacks that must be rejected**

```js
// tests/integration/local-api-security.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITY_MATRIX, startGuardedServer } from "../../src/security/local-api.js";

test("server rejects rebinding, CSRF, token replay, capability escalation, malformed JSON, and traversal", async (t) => {
  const server = await startGuardedServer({
    bootstrapNonce: "one-shot",
    principals: [
      { token:"injected-token", origins:["app://codex"], capabilities:CAPABILITY_MATRIX.injected },
      { token:"standalone-token", origins:["$self"], capabilities:CAPABILITY_MATRIX.standalone },
      { token:"mcp-token", origins:["projectboard-mcp://local"], capabilities:CAPABILITY_MATRIX.mcp },
    ],
  });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}`;
  const injected = { host:`127.0.0.1:${server.port}`, origin:"app://codex", authorization:"Bearer injected-token" };
  const json = { ...injected, "content-type":"application/json", "x-projectboard-version":"1" };
  assert.equal((await fetch(`${url}/state`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${url}/state`,{method:"POST",headers:{...json,host:"evil.example"},body:"{}"})).status,403);
  assert.equal((await fetch(`${url}/state`,{method:"POST",headers:{...json,origin:"https://evil.example"},body:"{}"})).status,403);
  assert.equal((await fetch(`${url}/state`,{method:"POST",headers:{...json,authorization:"Bearer wrong"},body:"{}"})).status,401);
  assert.equal((await fetch(`${url}/state`,{method:"POST",headers:{...json,"content-type":"text/plain"},body:"{}"})).status,415);
  assert.equal((await fetch(`${url}/state`,{method:"POST",headers:{...json,"x-projectboard-version":"2"},body:"{}"})).status,415);
  assert.equal((await fetch(`${url}/state`,{method:"POST",headers:json,body:"{"})).status,400);
  assert.equal((await fetch(`${url}/state`,{method:"POST",headers:json,body:JSON.stringify({ value:"x".repeat(65_537) })})).status,413);
  assert.equal((await fetch(`${url}/%2e%2e/secret`,{headers:injected})).status,404);

  const events = await fetch(`${url}/events`, { headers:injected });
  assert.equal(events.status,200);
  assert.match(events.headers.get("content-type"),/application\/x-ndjson/);
  assert.deepEqual(JSON.parse((await events.text()).trim()),{type:"ready"});
  assert.equal((await fetch(`${url}/evidence`,{method:"POST",headers:json,body:"{}"})).status,403);

  const standalone = { ...json, origin:url, authorization:"Bearer standalone-token" };
  assert.equal((await fetch(`${url}/state`,{method:"POST",headers:standalone,body:"{}"})).status,200);
  assert.equal((await fetch(`${url}/bootstrap`,{method:"POST",headers:standalone,body:JSON.stringify({nonce:"one-shot"})})).status,200);
  assert.equal((await fetch(`${url}/bootstrap`,{method:"POST",headers:standalone,body:JSON.stringify({nonce:"one-shot"})})).status,409);

  const mcp = { ...json, origin:"projectboard-mcp://local", authorization:"Bearer mcp-token" };
  assert.equal((await fetch(`${url}/evidence`,{method:"POST",headers:mcp,body:"{}"})).status,200);
  assert.equal((await fetch(`${url}/state`,{method:"POST",headers:mcp,body:"{}"})).status,403);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `node --test tests/integration/local-api-security.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the guarded server and explicit capability matrix**

```js
// src/security/local-api.js
import http from "node:http";
const send = (response, status, value) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
const MAX_JSON_BYTES = 65_536;
const ROUTES = new Map([
  ["GET /events","read:events"], ["GET /state","read:state"],
  ["POST /bootstrap","bootstrap"], ["POST /state","write:state"],
  ["POST /evidence","write:evidence"],
]);
export const CAPABILITY_MATRIX = Object.freeze({
  injected:Object.freeze(["read:events","read:state","write:state","bootstrap"]),
  standalone:Object.freeze(["read:events","read:state","write:state","bootstrap"]),
  mcp:Object.freeze(["write:evidence"]),
});

export async function startGuardedServer({ principals, bootstrapNonce }) {
  let nonce = bootstrapNonce;
  const server = http.createServer((request, response) => {
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (request.headers.host !== expectedHost) return send(response, 403, { error: "host" });
    const token = request.headers.authorization?.match(/^Bearer ([^ ]+)$/)?.[1];
    const principal = principals.find((candidate) => candidate.token === token);
    if (!principal) return send(response, 401, { error: "authorization" });
    const allowedOrigins = principal.origins.map((origin) => origin === "$self" ? `http://${expectedHost}` : origin);
    if (!allowedOrigins.includes(request.headers.origin)) return send(response, 403, { error: "origin" });
    let pathname;
    try { pathname = new URL(request.url, `http://${expectedHost}`).pathname; }
    catch { return send(response, 400, { error:"url" }); }
    const capability = ROUTES.get(`${request.method} ${pathname}`);
    if (!capability) return send(response, 404, { error:"route" });
    if (!principal.capabilities.includes(capability)) return send(response, 403, { error:"capability" });
    if (request.method === "GET") {
      if (pathname === "/events") { response.writeHead(200,{"content-type":"application/x-ndjson","cache-control":"no-store"}); return response.end(`${JSON.stringify({type:"ready"})}\n`); }
      return send(response, 200, { ok:true });
    }
    if (request.headers["content-type"] !== "application/json" || request.headers["x-projectboard-version"] !== "1") return send(response, 415, { error: "request-shape" });
    let body = ""; let bytes = 0; let oversized = false;
    request.on("data", (chunk) => { bytes += chunk.length; if (bytes > MAX_JSON_BYTES) oversized = true; else body += chunk; });
    request.on("end", () => {
      if (oversized) return send(response, 413, { error:"body-size" });
      let parsed;
      try { parsed = JSON.parse(body || "{}"); }
      catch { return send(response, 400, { error:"json" }); }
      if (pathname === "/bootstrap") {
        if (!nonce || parsed.nonce !== nonce) return send(response, 409, { error: "nonce" });
        nonce = null; return send(response, 200, { ok: true });
      }
      return send(response, 200, { ok: true });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

export async function probeLocalApiSecurity() {
  const server = await startGuardedServer({ bootstrapNonce:"probe-once", principals:[{token:"probe-bearer",origins:["app://codex"],capabilities:CAPABILITY_MATRIX.injected}] });
  try {
    const url=`http://127.0.0.1:${server.port}`;
    const unauthenticated=(await fetch(`${url}/state`,{method:"POST",body:"{}"})).status;
    const wrongOrigin=(await fetch(`${url}/state`,{method:"POST",headers:{host:`127.0.0.1:${server.port}`,origin:"https://evil.example",authorization:"Bearer probe-bearer","content-type":"application/json","x-projectboard-version":"1"},body:"{}"})).status;
    return { status:unauthenticated===401&&wrongOrigin===403?"pass":"fail", unauthenticated, wrongOrigin };
  } finally { await server.close(); }
}
```

- [ ] **Step 4: Run security tests**

Run: `node --test tests/integration/local-api-security.test.js`

Expected: 1 test passes, 0 fail.

- [ ] **Step 5: Commit localhost security**

```powershell
git add src/security tests/integration/local-api-security.test.js
git commit -m "test: harden Projectboard loopback boundary"
```

### Task 7: Enforce at-most-once recovery with SQLite

**Files:**
- Create: `src/journal/dispatch-journal.js`
- Test: `tests/unit/dispatch-journal.test.js`

- [ ] **Step 1: Write crash-boundary tests**

```js
// tests/unit/dispatch-journal.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DispatchJournal } from "../../src/journal/dispatch-journal.js";

test("sent but unconfirmed dispatch survives reopen, becomes unknown, and is never replayed", (t) => {
  const directory=mkdtempSync(path.join(tmpdir(),"phase0-journal-")); const file=path.join(directory,"journal.sqlite"); t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const first=new DatabaseSync(file); const journal = new DispatchJournal(first);
  journal.createIntent({ id: "run-1", requestDigest: "abc", fencingToken: 1 });
  journal.markSent("run-1"); first.close();
  const second=new DatabaseSync(file); const reopened=new DispatchJournal(second);
  assert.deepEqual(reopened.reconcile(), [{ id: "run-1", resolution: "unknown", autoReplay: false }]);
  assert.deepEqual(reopened.reconcile(),[]); second.close();
});

test("confirmed dispatch remains confirmed", () => {
  const journal = new DispatchJournal(new DatabaseSync(":memory:"));
  journal.createIntent({ id: "run-2", requestDigest: "def", fencingToken: 2 });
  journal.markSent("run-2"); journal.markConfirmed("run-2", { threadId: "thr", turnId: "turn" });
  assert.deepEqual(journal.reconcile(), []);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/unit/dispatch-journal.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement journal transitions**

```js
// src/journal/dispatch-journal.js
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
export class DispatchJournal {
  constructor(database) {
    this.database = database;
    database.exec("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS dispatch_journal (id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,fencing_token INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('intent','sent','confirmed','unknown')),thread_id TEXT,turn_id TEXT);");
  }
  createIntent({ id, requestDigest, fencingToken }) { this.database.prepare("INSERT INTO dispatch_journal(id,request_digest,fencing_token,status) VALUES(?,?,?,'intent')").run(id, requestDigest, fencingToken); }
  markSent(id) { if (this.database.prepare("UPDATE dispatch_journal SET status='sent' WHERE id=? AND status='intent'").run(id).changes !== 1) throw new Error("Invalid intent transition"); }
  markConfirmed(id, { threadId, turnId }) { if (this.database.prepare("UPDATE dispatch_journal SET status='confirmed',thread_id=?,turn_id=? WHERE id=? AND status='sent'").run(threadId, turnId, id).changes !== 1) throw new Error("Invalid confirmation transition"); }
  reconcile() {
    const rows = this.database.prepare("SELECT id FROM dispatch_journal WHERE status IN ('intent','sent') ORDER BY id").all();
    const mark = this.database.prepare("UPDATE dispatch_journal SET status='unknown' WHERE id=?");
    return rows.map(({ id }) => { mark.run(id); return { id, resolution: "unknown", autoReplay: false }; });
  }
}

export function probeDispatchRecovery() {
  const directory=mkdtempSync(path.join(tmpdir(),"phase0-dispatch-probe-")); const file=path.join(directory,"journal.sqlite");
  try {
    const first=new DatabaseSync(file); const journal=new DispatchJournal(first);
    journal.createIntent({id:"phase0",requestDigest:"fixed-probe",fencingToken:1}); journal.markSent("phase0"); first.close();
    const second=new DatabaseSync(file); const result=new DispatchJournal(second).reconcile(); second.close();
    return {status:result.length===1&&result[0].autoReplay===false?"pass":"fail",result,reopened:true};
  } finally { rmSync(directory,{recursive:true,force:true}); }
}
```

- [ ] **Step 4: Run journal tests twice**

Run: `node --test tests/unit/dispatch-journal.test.js`

Expected: 2 tests pass, 0 fail.

Run: `node --test tests/unit/dispatch-journal.test.js`

Expected: the same result with no stale-file dependency.

- [ ] **Step 5: Commit recovery behavior**

```powershell
git add src/journal/dispatch-journal.js tests/unit/dispatch-journal.test.js
git commit -m "feat: enforce at-most-once dispatch recovery"
```

### Task 8: Bind approvals to instance, digest, expiry, and human identity

**Files:**
- Create: `src/approvals/approval-store.js`
- Test: `tests/unit/approval-store.test.js`

- [ ] **Step 1: Write approval rejection tests**

```js
// tests/unit/approval-store.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApprovalStore, digestApproval } from "../../src/approvals/approval-store.js";
const request = { instanceId: "instance-a", requestId: 7, requestMethod:"item/commandExecution/requestApproval", threadId: "thr", turnId: "turn", itemId: "item", command: "Get-Location", cwd: "C:\\tmp", scope:{network:null,additionalPermissions:null,grantRoot:null} };

test("agent responder cannot approve", () => {
  const store = new ApprovalStore(new DatabaseSync(":memory:"),() => 1000); store.add(request, 5000);
  assert.throws(() => store.respond({ requestId: 7, responder: "mcp-agent", instanceId: "instance-a", digest: digestApproval(request), decision: "accept" }), /human-ui/);
});

test("expired approval cannot be answered", () => {
  const store = new ApprovalStore(new DatabaseSync(":memory:"),() => 6001); store.add(request, 5000);
  assert.throws(() => store.respond({ requestId: 7, responder: "human-ui", instanceId: "instance-a", digest: digestApproval(request), decision: "decline" }), /expired/);
});

test("changed instance is rejected without destroying the pending approval", () => {
  const store=new ApprovalStore(new DatabaseSync(":memory:"),()=>1000); store.add(request,5000);
  assert.throws(()=>store.respond({requestId:7,responder:"human-ui",instanceId:"instance-b",digest:digestApproval(request),decision:"decline"}),/identity changed/);
  assert.deepEqual(store.respond({requestId:7,responder:"human-ui",instanceId:"instance-a",digest:digestApproval(request),decision:"decline"}),{requestId:7,decision:"decline",replayed:false});
});

test("changed command digest is rejected without destroying the pending approval", () => {
  const store=new ApprovalStore(new DatabaseSync(":memory:"),()=>1000); store.add(request,5000);
  const changed=digestApproval({...request,command:"Remove-Item marker.txt"});
  assert.throws(()=>store.respond({requestId:7,responder:"human-ui",instanceId:"instance-a",digest:changed,decision:"decline"}),/identity changed/);
  assert.equal(store.respond({requestId:7,responder:"human-ui",instanceId:"instance-a",digest:digestApproval(request),decision:"decline"}).replayed,false);
});

test("duplicate identical decline is idempotent", () => {
  const store=new ApprovalStore(new DatabaseSync(":memory:"),()=>1000); store.add(request,5000);
  const response={requestId:7,responder:"human-ui",instanceId:"instance-a",digest:digestApproval(request),decision:"decline"};
  assert.equal(store.respond(response).replayed,false);
  assert.equal(store.respond(response).replayed,true);
});

test("unknown decisions are rejected", () => {
  const store=new ApprovalStore(new DatabaseSync(":memory:"),()=>1000); store.add(request,5000);
  assert.throws(()=>store.respond({requestId:7,responder:"human-ui",instanceId:"instance-a",digest:digestApproval(request),decision:"accept-later"}),/decision/);
});

test("pending approval survives database reopen", (t) => {
  const directory=mkdtempSync(path.join(tmpdir(),"phase0-approval-")); const file=path.join(directory,"approval.sqlite");
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const firstDb=new DatabaseSync(file); new ApprovalStore(firstDb,()=>1000).add(request,5000); firstDb.close();
  const secondDb=new DatabaseSync(file); const result=new ApprovalStore(secondDb,()=>2000).respond({requestId:7,responder:"human-ui",instanceId:"instance-a",digest:digestApproval(request),decision:"decline"}); secondDb.close();
  assert.deepEqual(result,{requestId:7,decision:"decline",replayed:false});
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/unit/approval-store.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement digest and response checks**

```js
// src/approvals/approval-store.js
import { createHash } from "node:crypto";
export function digestApproval(value) {
  const canonical = JSON.stringify({
    instanceId:String(value.instanceId),requestId:String(value.requestId),requestMethod:value.requestMethod,
    threadId:value.threadId??null,turnId:value.turnId??null,itemId:value.itemId??null,
    command:value.command??null,cwd:value.cwd??null,network:value.scope?.network??value.network??null,
    additionalPermissions:value.scope?.additionalPermissions??value.additionalPermissions??null,
    grantRoot:value.scope?.grantRoot??value.grantRoot??null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
export class ApprovalStore {
  constructor(database,now = Date.now) {
    this.database=database; this.now=now;
    database.exec("CREATE TABLE IF NOT EXISTS approvals(instance_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','denied','approved','expired','invalidated')),decision TEXT,PRIMARY KEY(instance_id,request_id));");
  }
  add(request, expiresAt) { this.database.prepare("INSERT INTO approvals(instance_id,request_id,digest,payload,expires_at,status) VALUES(?,?,?,?,?,'pending')").run(String(request.instanceId),String(request.requestId),digestApproval(request),JSON.stringify(request),expiresAt); }
  respond({ requestId, responder, instanceId, digest, decision }) {
    if (responder !== "human-ui") throw new Error("only human-ui may respond");
    if (decision !== "decline" && decision !== "accept") throw new Error("invalid approval decision");
    const row = this.database.prepare("SELECT * FROM approvals WHERE instance_id=? AND request_id=?").get(String(instanceId),String(requestId));
    if (!row) {
      const colliding = this.database.prepare("SELECT 1 FROM approvals WHERE request_id=? LIMIT 1").get(String(requestId));
      throw new Error(colliding ? "approval identity changed" : "approval is not pending");
    }
    if (digest !== row.digest) throw new Error("approval identity changed");
    if (this.now() > row.expires_at && row.status === "pending") { this.database.prepare("UPDATE approvals SET status='expired' WHERE instance_id=? AND request_id=? AND status='pending'").run(String(instanceId),String(requestId)); throw new Error("approval expired"); }
    if (row.status !== "pending") {
      if (row.decision === decision) return { requestId, decision, replayed:true };
      throw new Error("approval is not pending");
    }
    const status=decision === "decline" ? "denied" : "approved";
    const update=this.database.prepare("UPDATE approvals SET status=?,decision=? WHERE instance_id=? AND request_id=? AND status='pending'").run(status,decision,String(instanceId),String(requestId));
    if (update.changes !== 1) throw new Error("approval response race");
    return { requestId, decision, replayed:false };
  }
}
```

- [ ] **Step 4: Run approval tests**

Run: `node --test tests/unit/approval-store.test.js`

Expected: 7 tests pass, 0 fail.

- [ ] **Step 5: Commit approval identity enforcement**

```powershell
git add src/approvals/approval-store.js tests/unit/approval-store.test.js
git commit -m "feat: bind approvals to human session identity"
```

### Task 9: Add explicit-consent live probes

**Files:**
- Create: `src/live/live-probes.js`
- Test: `tests/unit/live-probe-consent.test.js`
- Modify: `src/app-server/probe-readonly.js`

- [ ] **Step 1: Write consent tests before live RPC**

```js
// tests/unit/live-probe-consent.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStartRace, validateLiveConsent } from "../../src/live/live-probes.js";

test("live probes require persistent-thread and model-turn consent", () => {
  assert.throws(() => validateLiveConsent({ allowPersistentThread:true, allowModelTurns:false }), /model turns/);
  assert.throws(() => validateLiveConsent({ allowPersistentThread:false, allowModelTurns:true }), /persistent thread/);
  assert.deepEqual(validateLiveConsent({ allowPersistentThread:true, allowModelTurns:true }), { persistentThreads:1, modelTurns:2, approvals:"decline-only" });
  const conflict=Object.assign(new Error("active turn"),{rpc:{code:-32000,data:{reason:"activeTurn"}}});
  assert.equal(evaluateStartRace([{status:"fulfilled",value:{turn:{id:"turn-a"}}},{status:"rejected",reason:conflict}]).status,"pass");
  assert.equal(evaluateStartRace([{status:"fulfilled",value:{turn:{id:"turn-a"}}},{status:"rejected",reason:new Error("transport timed out")}]).status,"fail");
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `node --test tests/unit/live-probe-consent.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement consent, marker thread, and synchronized turn race**

```js
// src/live/live-probes.js
import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApprovalStore, digestApproval } from "../approvals/approval-store.js";
import { openAppServer, listAllThreadMetadata } from "../app-server/probe-readonly.js";
export function validateLiveConsent({ allowPersistentThread, allowModelTurns }) {
  if (!allowPersistentThread && allowModelTurns) throw new Error("model turns require persistent thread consent");
  if (allowPersistentThread && !allowModelTurns) throw new Error("live compatibility requires model turns consent");
  if (!allowPersistentThread && !allowModelTurns) throw new Error("live probes require explicit consent");
  return { persistentThreads:1, modelTurns:2, approvals:"decline-only" };
}
export async function createVisibilityMarker(peer, cwd) {
  const marker = `[Projectboard Phase 0] ${randomUUID()}`;
  const started = await peer.request("thread/start", { cwd, approvalPolicy:"never", sandbox:"readOnly", serviceName:"projectboard_phase0" });
  await peer.request("thread/name/set", { threadId:started.thread.id, name:marker });
  return { threadId:started.thread.id, marker };
}
export async function raceTurnStart(peerA, peerB, threadId) {
  return Promise.allSettled([
    peerA.request("turn/start", { threadId, input:[{type:"text",text:"Reply with exactly A and do not use tools."}], approvalPolicy:"never", sandboxPolicy:{type:"readOnly"} }),
    peerB.request("turn/start", { threadId, input:[{type:"text",text:"Reply with exactly B and do not use tools."}], approvalPolicy:"never", sandboxPolicy:{type:"readOnly"} }),
  ]);
}
export function evaluateStartRace(results) {
  const accepted=results.map((result,index)=>({result,index})).filter(({result})=>result.status==="fulfilled");
  const rejected=results.filter((result)=>result.status==="rejected");
  const explicitConflict=rejected.length===1&&rejected[0].reason?.rpc&&/active|busy|in.?progress/i.test(`${rejected[0].reason.message} ${JSON.stringify(rejected[0].reason.rpc.data??{})}`);
  return {status:accepted.length===1&&explicitConflict?"pass":"fail",accepted:accepted.length,explicitConflict:Boolean(explicitConflict),acceptedEntries:accepted};
}

function waitForEvent(emitter, event, predicate, timeoutMs = 15000) {
  const history=event==="notification"?emitter.notifications:event==="serverRequest"?emitter.serverRequests:[];
  const existing=history?.find(predicate); if(existing)return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`${event} timeout`)); }, timeoutMs);
    const listener = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer); emitter.off(event, listener); resolve(value);
    };
    emitter.on(event, listener);
  });
}

export async function runDeclineOnlyApprovalProbe(peer, { instanceId, threadId, markerPath, approvalStore }) {
  const approvalWait = waitForEvent(peer, "serverRequest", (message) => new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]).has(message.method));
  await peer.request("turn/start", {
    threadId,
    input: [{ type:"text", text:`Attempt exactly one PowerShell command that writes the word probe to ${markerPath}. Do not use another path.` }],
    approvalPolicy:"untrusted",
    sandboxPolicy:{ type:"readOnly" },
  });
  let approval;
  try { approval = await approvalWait; }
  catch { return { status:"inconclusive", reason:"no approval request" }; }
  const request = { instanceId, requestId:approval.id, requestMethod:approval.method, threadId:approval.params.threadId, turnId:approval.params.turnId, itemId:approval.params.itemId, command:approval.params.command??null, cwd:approval.params.cwd??null, scope:{network:approval.params.networkApprovalContext??null,additionalPermissions:approval.params.additionalPermissions??null,grantRoot:approval.params.grantRoot??null} };
  approvalStore.add(request, Date.now()+30000);
  const decision = approvalStore.respond({ requestId:approval.id, responder:"human-ui", instanceId, digest:digestApproval(request), decision:"decline" });
  const resolvedWait = waitForEvent(peer,"notification",(message)=>message.method==="serverRequest/resolved"&&String(message.params.requestId)===String(approval.id));
  const itemWait = waitForEvent(peer,"notification",(message)=>message.method==="item/completed"&&message.params.item.id===approval.params.itemId);
  const turnWait = waitForEvent(peer,"notification",(message)=>message.method==="turn/completed"&&message.params.turn.id===approval.params.turnId,60000);
  peer.respond(approval.id,{decision:decision.decision});
  const [,item] = await Promise.all([resolvedWait,itemWait,turnWait]);
  const absent = await access(markerPath).then(() => false, () => true);
  return { status:absent&&item.params.item.status==="declined"?"pass":"fail", requestMethod:approval.method, markerAbsent:absent, itemStatus:item.params.item.status };
}

export async function runLiveSuite(binary, sourceKinds, fixtureCwd, confirmDesktop) {
  await mkdir(fixtureCwd,{recursive:true});
  let first; let second; let approvalDatabase;
  try {
    first=await openAppServer(binary); second=await openAppServer(binary);
    approvalDatabase=new DatabaseSync(path.join(fixtureCwd,"phase0-approvals.sqlite"));
    const approvalStore=new ApprovalStore(approvalDatabase);
    const marker=await createVisibilityMarker(first.peer,fixtureCwd);
    const visible=(await listAllThreadMetadata(second.peer,false,sourceKinds)).some((thread)=>thread.id===marker.threadId);
    const desktopConfirmed=confirmDesktop?await confirmDesktop(marker):false;
    await second.peer.request("thread/resume",{threadId:marker.threadId});
    const raced=await raceTurnStart(first.peer,second.peer,marker.threadId);
    const doubleWrite=evaluateStartRace(raced); const accepted=doubleWrite.acceptedEntries;
    let approval={status:"skipped",reason:"double-write gate failed"};
    if(doubleWrite.status==="pass"){
      const winner=accepted[0].index===0?first.peer:second.peer;
      const turnId=accepted[0].result.value.turn.id;
      await waitForEvent(winner,"notification",(message)=>message.method==="turn/completed"&&message.params.turn.id===turnId,60000);
      approval=await runDeclineOnlyApprovalProbe(winner,{instanceId:`phase0-${marker.threadId}`,threadId:marker.threadId,markerPath:path.join(fixtureCwd,`approval-marker-${randomUUID()}.txt`),approvalStore});
    } else if(accepted.length>0) {
      await Promise.allSettled(accepted.map(({result,index})=>(index===0?first.peer:second.peer).request("turn/interrupt",{threadId:marker.threadId,turnId:result.value.turn.id})));
    }
    const {acceptedEntries,...doubleWriteEvidence}=doubleWrite;
    return { marker, appServerIdentity:{status:visible&&desktopConfirmed?"pass":"inconclusive",visibleAcrossProcesses:visible,desktopConfirmed}, doubleWriteControl:doubleWriteEvidence, approvalLifecycle:approval };
  } finally { approvalDatabase?.close(); first?.child.kill(); second?.child.kill(); }
}
```

The CLI prints the command/cwd/scope from the persisted request before calling `runDeclineOnlyApprovalProbe`'s response branch. The fixed result remains `decline`; the UI display is evidence, not an approval control in Phase 0.

The double-write gate passes only when exactly one `turn/start` succeeds and the other returns an explicit active/busy/in-progress App Server RPC conflict. A timeout, closed transport, or generic error is not evidence of mutual exclusion. If both succeed, the harness interrupts both turns, records No-Go, and Phase 2 remains blocked until a dedicated-thread plus explicit-control-transfer probe is added and passes.

- [ ] **Step 4: Run deterministic tests without live flags**

Run: `npm.cmd test`

Expected: all tests pass; no native thread ID is reported and no model turn runs.

- [ ] **Step 5: Commit consent-gated live probes**

```powershell
git add src/live/live-probes.js src/app-server/probe-readonly.js tests/unit/live-probe-consent.test.js
git commit -m "feat: gate live Codex compatibility probes"
```

### Task 10: Orchestrate probes and write immutable evidence

**Files:**
- Create: `src/report/write-report.js`
- Create: `src/cli.js`
- Create: `src/orchestrator.js`
- Create: `docs/phase-0-runbook.md`
- Test: `tests/unit/cli-arguments.test.js`
- Test: `tests/unit/orchestrator.test.js`
- Test: `tests/integration/report-output.test.js`

- [ ] **Step 1: Write CLI and report tests**

```js
// tests/unit/cli-arguments.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { parseArguments } from "../../src/cli.js";
test("readonly is the only implicit mode", () => {
  assert.deepEqual(parseArguments(["readonly"]), { mode:"readonly",allowCodexRestart:false,probeExistingInstance:false,allowPersistentThread:false,allowModelTurns:false,fixtureCwd:null });
  assert.throws(() => parseArguments(["live","--allow-model-turns"]), /persistent thread/);
  assert.throws(() => parseArguments(["live","--allow-persistent-thread"]), /model turns/);
  assert.throws(() => parseArguments(["live","--allow-codex-restart","--probe-existing-instance"]), /mutually exclusive/);
  assert.throws(() => parseArguments(["live","--unknown"]), /unknown argument/);
});
```

```js
// tests/unit/orchestrator.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { runPhase0 } from "../../src/orchestrator.js";

test("one failed probe does not erase later evidence", async () => {
  const calls=[];
  const probes={
    windows_inventory:async()=>{calls.push("windows_inventory");return {count:1};},
    app_server_identity:async()=>{calls.push("app_server_identity");throw new Error("mismatch");},
    local_api_security:async()=>{calls.push("local_api_security");return {status:"pass"};},
    dispatch_recovery:async()=>{calls.push("dispatch_recovery");return {status:"pass"};},
  };
  const report=await runPhase0({mode:"readonly"},probes);
  assert.deepEqual(calls,["windows_inventory","app_server_identity","local_api_security","dispatch_recovery"]);
  assert.equal(report.gates.find((gate)=>gate.id==="app_server_identity").status,"fail");
  assert.equal(report.gates.find((gate)=>gate.id==="dispatch_recovery").status,"pass");
});
```

```js
// tests/integration/report-output.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeReport } from "../../src/report/write-report.js";
test("report is immutable and redacts secrets", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "projectboard-phase0-")); const directory=path.join(parent,"run");
  t.after(()=>rm(parent,{recursive:true,force:true}));
  await writeReport(directory, { schemaVersion:1,runId:"run",gates:[{id:"probe",status:"pass",evidence:[{bearer:"secret-value",bootstrapNonce:"one-shot",safe:"visible"}],notes:[]}],phases:{},redactions:["bearer","nonce"] });
  const report=await readFile(path.join(directory,"report.json"),"utf8");
  assert.equal(report.includes("secret-value")||report.includes("one-shot"), false);
  assert.equal(report.includes("visible"),true);
  assert.equal((await readFile(path.join(directory,"summary.md"),"utf8")).includes("# Phase 0 Compatibility Report"), true);
  await assert.rejects(()=>writeReport(directory,{schemaVersion:1,runId:"overwrite",gates:[],phases:{}}),/exist/i);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/unit/cli-arguments.test.js tests/integration/report-output.test.js`

Expected: FAIL with missing CLI/report modules.

- [ ] **Step 3: Implement atomic report and strict arguments**

```js
// src/orchestrator.js
import { GATE_IDS, evaluatePhases } from "./report/model.js";

const ORDER=["windows_inventory","secure_injection","app_server_identity","local_api_security","dispatch_recovery","approval_lifecycle","double_write_control"];
export async function runPhase0(options,probes){
  const gates=[]; const context={options};
  for(const id of ORDER){
    const probe=probes[id];
    if(!probe){ gates.push({id,status:"skipped",evidence:[],notes:["probe not enabled"]}); continue; }
    try {
      const value=await probe(context); context[id]=value;
      gates.push({id,status:value.status??"pass",evidence:[value],notes:value.notes??[]});
    } catch(error){ gates.push({id,status:"fail",evidence:[],notes:[error.message]}); }
  }
  for(const id of GATE_IDS) if(!gates.some((gate)=>gate.id===id)) gates.push({id,status:"skipped",evidence:[],notes:["not scheduled"]});
  return {schemaVersion:1,runId:options.runId,options,gates,phases:evaluatePhases(gates),redactions:["bearer","nonce","full-thread-content"]};
}
```

```js
// src/report/write-report.js
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
const REDACTED_KEY=/(bearer|token|nonce|prompt|full.*thread|thread.*body)/i;
function sanitize(value,key="") {
  if(REDACTED_KEY.test(key))return "[REDACTED]";
  if(Array.isArray(value))return value.map((entry)=>sanitize(entry));
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([name,entry])=>[name,sanitize(entry,name)]));
  return value;
}
export async function writeReport(directory, report) {
  await mkdir(directory,{recursive:true});
  const seal=path.join(directory,".report-sealed"); const writing=path.join(directory,".report-writing");
  if(await access(seal).then(()=>true,()=>false))throw new Error("report already exists");
  await writeFile(writing,report.runId,{flag:"wx"});
  const safeReport=sanitize(report);
  const jsonTemp=path.join(directory,"report.json.tmp"); const jsonPath=path.join(directory,"report.json");
  const mdTemp=path.join(directory,"summary.md.tmp"); const mdPath=path.join(directory,"summary.md");
  const rows=safeReport.gates.map((gate)=>`| ${gate.id} | ${gate.status} | ${(gate.notes??[]).join("; ")} |`).join("\n");
  await writeFile(jsonTemp,JSON.stringify(safeReport,null,2),{flag:"wx"});
  await writeFile(mdTemp,`# Phase 0 Compatibility Report\n\nRun: ${safeReport.runId}\n\n| Gate | Status | Notes |\n|---|---|---|\n${rows}\n`,{flag:"wx"});
  await rename(jsonTemp,jsonPath); await rename(mdTemp,mdPath); await rename(writing,seal);
}
```

```js
// src/cli.js
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { collectWindowsInventory } from "./windows/inventory.js";
import { discoverCandidates, fingerprintCandidates } from "./app-server/candidates.js";
import { readThreadSourceKinds } from "./app-server/schema-contract.js";
import { probeAppServerIdentity } from "./app-server/probe-readonly.js";
import { probeLocalApiSecurity } from "./security/local-api.js";
import { probeDispatchRecovery } from "./journal/dispatch-journal.js";
import { probeSecureInjection } from "./cdp/port-probe.js";
import { runLiveSuite } from "./live/live-probes.js";
import { runCommand } from "./process/run-command.js";
import { runPhase0 } from "./orchestrator.js";
import { writeReport } from "./report/write-report.js";
export function parseArguments(argv) {
  const mode=argv[0]??"readonly"; if(!new Set(["readonly","live"]).has(mode)) throw new Error("mode must be readonly or live");
  const booleanFlags=new Set(["--allow-codex-restart","--probe-existing-instance","--allow-persistent-thread","--allow-model-turns"]); const valueFlags=new Set(["--fixture-cwd"]);
  for(let index=1;index<argv.length;index+=1){const argument=argv[index];if(booleanFlags.has(argument))continue;if(valueFlags.has(argument)){if(!argv[index+1]||argv[index+1].startsWith("--"))throw new Error(`${argument} requires a value`);index+=1;continue;}throw new Error(`unknown argument: ${argument}`);}
  const has=(flag)=>argv.includes(flag); const value=(flag)=>{const index=argv.indexOf(flag);return index<0?null:argv[index+1];};
  const result={mode,allowCodexRestart:has("--allow-codex-restart"),probeExistingInstance:has("--probe-existing-instance"),allowPersistentThread:has("--allow-persistent-thread"),allowModelTurns:has("--allow-model-turns"),fixtureCwd:value("--fixture-cwd")};
  if(result.allowCodexRestart&&result.probeExistingInstance) throw new Error("restart and existing-instance probes are mutually exclusive");
  if(result.allowModelTurns&&!result.allowPersistentThread) throw new Error("model turns require persistent thread consent");
  if(result.allowPersistentThread&&!result.allowModelTurns) throw new Error("persistent thread probe requires model turns consent");
  if(result.allowModelTurns&&!result.fixtureCwd) throw new Error("model turns require --fixture-cwd");
  if(result.fixtureCwd&&!result.allowModelTurns) throw new Error("--fixture-cwd is only valid with model turns");
  if(result.fixtureCwd&&!path.isAbsolute(result.fixtureCwd)) throw new Error("--fixture-cwd must be absolute");
  if(mode==="readonly"&&(result.allowCodexRestart||result.probeExistingInstance||result.allowPersistentThread||result.allowModelTurns)) throw new Error("readonly mode rejects mutation flags");
  return result;
}
export async function main(argv) {
  const parsed=parseArguments(argv); const runId=randomUUID();
  const reportDirectory=path.join("artifacts","phase-0",new Date().toISOString().replaceAll(":","-")+"-"+runId);
  const options={...parsed,runId,reportDirectory};
  const probes={
    windows_inventory:async()=>{ const inventory=await collectWindowsInventory(); return {...inventory,status:inventory.startApps.length>0&&inventory.commands.length>0?"pass":"inconclusive"}; },
    app_server_identity:async(context)=>{
      const candidates=await discoverCandidates(context.windows_inventory); const fingerprints=await fingerprintCandidates(candidates); const selected=fingerprints.find((candidate)=>candidate.accessible&&!candidate.fingerprintError);
      if(!selected) throw new Error("no accessible App Server candidate");
      context.selectedCandidate=selected;
      const schemaDirectory=path.join(reportDirectory,"schema");
      const generated=await runCommand(process.execPath,["scripts/generate-app-server-schema.mjs",selected.path,schemaDirectory]);
      if(generated.code!==0) throw new Error(generated.stderr||"schema generation failed");
      const sourceKinds=await readThreadSourceKinds(schemaDirectory);
      const manifest=JSON.parse(await readFile(path.join(schemaDirectory,"binary-manifest.json"),"utf8"));
      if(manifest.sha256!==selected.sha256||manifest.version!==selected.version)throw new Error("selected App Server changed during fingerprint/schema generation");
      const versions=[...new Set(fingerprints.filter((candidate)=>candidate.version).map((candidate)=>candidate.version))];
      const safe=await probeAppServerIdentity(selected.path,sourceKinds);
      if(options.allowPersistentThread&&options.allowModelTurns){
        context.live=await runLiveSuite(selected.path,sourceKinds,options.fixtureCwd,async(marker)=>{
          const terminal=createInterface({input:process.stdin,output:process.stderr});
          const answer=await terminal.question(`Open Codex, find ${marker.marker}, then type its thread ID (or press Enter to mark inconclusive): `);
          terminal.close(); return answer.trim()===marker.threadId;
        });
        const desktopIdentity=context.live.appServerIdentity; const status=desktopIdentity.status==="pass"&&selected.origin==="package"?"pass":"inconclusive";
        return {...safe,...desktopIdentity,status,notes:status==="pass"?[]:["desktop package helper identity was not proven"],candidateOrigin:selected.origin,candidatePath:selected.path,candidateVersion:manifest.version,candidateSha256:manifest.sha256,candidateVersionDrift:versions.length>1,candidates:fingerprints,sourceKinds};
      }
      return {...safe,status:"inconclusive",notes:["desktop thread visibility was not confirmed"],candidateOrigin:selected.origin,candidatePath:selected.path,candidateVersion:manifest.version,candidateSha256:manifest.sha256,candidateVersionDrift:versions.length>1,candidates:fingerprints,sourceKinds};
    },
    local_api_security:async()=>probeLocalApiSecurity(),
    dispatch_recovery:async()=>probeDispatchRecovery(),
    secure_injection:async(context)=>(options.allowCodexRestart||options.probeExistingInstance)?probeSecureInjection(context.windows_inventory):{status:"skipped",notes:["activation consent not granted"]},
    approval_lifecycle:async(context)=>context.live?.approvalLifecycle??{status:"skipped",notes:["live consent not granted"]},
    double_write_control:async(context)=>context.live?.doubleWriteControl??{status:"skipped",notes:["live consent not granted"]},
  };
  const report=await runPhase0(options,probes); await writeReport(reportDirectory,report);
  return {...report,reportDirectory};
}
if(import.meta.url===pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((report)=>console.log(JSON.stringify({reportDirectory:report.reportDirectory,phases:report.phases},null,2))).catch((error)=>{console.error(error.message);process.exitCode=1;});
```

`docs/phase-0-runbook.md` contains:

```powershell
# Safe: no restart, persistent thread, or model turn
npm.cmd run probe

# User manually closes Codex; harness never kills it
node src/cli.js live --allow-codex-restart

# Codex stays open; measures single-instance argument handoff
node src/cli.js live --probe-existing-instance

# One named thread, at most two short turns, decline-only approvals
node src/cli.js live --allow-codex-restart --allow-persistent-thread --allow-model-turns --fixture-cwd C:\tmp\projectboard-phase0
```

- [ ] **Step 4: Run complete deterministic suite and safe probe**

Run: `npm.cmd test`

Expected: all tests pass, 0 fail.

Run: `npm.cmd run probe`

Expected: one report directory, no Codex restart, no native thread creation, and distinct conclusions for standalone, injected, Phase 2, and Phase 3.

- [ ] **Step 5: Commit orchestrator and runbook**

```powershell
git add src/cli.js src/orchestrator.js src/report/write-report.js docs/phase-0-runbook.md tests/unit/cli-arguments.test.js tests/unit/orchestrator.test.js tests/integration/report-output.test.js
git commit -m "feat: produce Phase zero compatibility verdicts"
```

### Task 11: Verify entry and exit gates

**Files:**
- Modify: `docs/phase-0-runbook.md`
- Create during verification only: `artifacts/phase-0/<run-id>/*` (ignored)

- [ ] **Step 1: Run static checks**

Run:

```powershell
git diff --check
Get-ChildItem -Recurse -File src,scripts | Select-String -Pattern 'TO[D]O|TB[D]|PLACEHOLDE[R]|Page\.setBypassCSP|thread/delete|thread/archive'
```

Expected: diff check exits 0 and search returns no matches.

- [ ] **Step 2: Run deterministic tests from a clean process**

Run: `npm.cmd test`

Expected: all tests pass, 0 fail; no live flags are present.

- [ ] **Step 3: Run safe probe twice**

Run: `npm.cmd run probe`

Expected: exit 0 with a new immutable report directory.

Run: `npm.cmd run probe`

Expected: a second report; the first is unchanged and neither contains a credential or full thread body.

- [ ] **Step 4: Review live scope with the user**

Show the exact candidate path/hash, restart mode, fixture directory, one-thread/two-turn quota, decline-only approval behavior, and retained marker-thread name. Do not run the live command until the user explicitly approves that concrete scope.

- [ ] **Step 5: Run the approved live probe and preserve failures**

Run first while the normal Codex window is already open:

```powershell
node src/cli.js live --probe-existing-instance
```

Expected: the report records whether single-instance activation preserved debugging arguments; an unavailable endpoint is valid failure evidence.

Then manually close all Codex windows and run the cold-start/full probe, only after Step 4 approval:

```powershell
node src/cli.js live --allow-codex-restart --allow-persistent-thread --allow-model-turns --fixture-cwd C:\tmp\projectboard-phase0
```

Expected: evidence for the Windows inventory prerequisite and all six Phase 0 safety gates. `fail`, `inconclusive`, and `skipped` block dependent phases and are never coerced to pass.

- [ ] **Step 6: Commit verification documentation only**

```powershell
git add docs/phase-0-runbook.md
git commit -m "docs: record Phase zero operating contract"
```

Do not commit `artifacts/`, credentials, nonces, complete thread content, or user-specific absolute paths.

## Plan self-review checklist

| Approved specification requirement | Plan coverage |
|---|---|
| Windows identity, AUMID, cold/hot launch, no hard-coded WindowsApps path | Tasks 2 and 5 |
| Debugging pipe preferred; loopback port is unauthenticated; no CSP bypass | Task 5 |
| All App Server candidate origins/versions/hashes, generated schema, account/data visibility | Tasks 3, 4, 9, and 10 |
| Initialize/initialized, active+archived pagination, stable API only | Task 4 |
| Persistent approval identity, expiry, human-only response, decline-only live probe, resolved event | Tasks 8 and 9 |
| True simultaneous start race, explicit RPC-conflict proof, and fail-closed fallback requirement | Task 9 |
| Durable intent/sent/confirmed journal and unknown without replay | Task 7 |
| Host/Origin/Bearer/request-shape/nonce, capability, body-limit, and traversal controls for injected, standalone, and MCP principals | Task 6 |
| Machine-readable evidence, phase-specific verdicts, no forced pass | Tasks 1, 10, and 11 |
| No native thread archive/delete and explicit consent for one retained fixture thread | Safety contract and Tasks 9–11 |

- Phase 0 records Windows inventory as prerequisite evidence, then evaluates the six safety gates: safe injection, App Server identity, approval lifecycle, double-write control, dispatch recovery, and local API security.
- Default execution cannot restart Codex, create a thread, invoke a model, approve a command, archive a thread, or delete a thread.
- Live mutations require explicit flags and a second user confirmation with concrete paths and quota.
- App Server initialization, stable JSONL, generated schema, pagination, and approval resolution have named tasks.
- CDP port mode is a downgrade, random ports are not authentication, and CSP bypass is forbidden.
- Recovery never claims exactly-once and never automatically replays unknown requests.
- Phase 3 remains blocked until a separate Git/worktree safety plan passes.
- Names remain consistent: `JsonlPeer`, `collectWindowsInventory`, `rankCandidates`, `fingerprintCandidates`, `readThreadSourceKinds`, `probePort`, `probeDirectPipe`, `probePipeInjection`, `DispatchJournal`, `ApprovalStore`, `validateLiveConsent`, `writeReport`, and `parseArguments`.
