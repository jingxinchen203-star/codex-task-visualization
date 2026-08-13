# Staged Command Launch Resource Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give downstream App Server code an owned private staged launch resource while preventing candidate evidence from claiming that an untested original path is directly spawnable.

**Architecture:** Extend the existing guarded resolver/stager in `run-command.js` with an exported resource factory, keeping all ephemeral paths inside the owned resource and all persisted candidate recipes declarative. Candidate viability requires an exact staged probe and exposes direct and staged launchability as separate fields.

**Tech Stack:** Node.js ESM, `node:child_process`, `node:fs`, `node:test`, strict assertions.

---

### Task 1: Lock the candidate launch contract

**Files:**
- Modify: `tests/unit/app-server-candidates.test.js`
- Modify: `src/app-server/candidates.js`

- [ ] **Step 1: Write the failing candidate contract test**

Add a staged result with `binding: { kind: "private-staged-snapshot", exact: true }` and assert:

```js
assert.equal(row.directSpawnable, null);
assert.equal(row.stagedExecutable, true);
assert.deepEqual(row.launchRecipe, { kind: "private-staged-snapshot", requestedPath: "package.exe" });
assert.equal(row.stagedBinding.exact, true);
assert.equal("spawnable" in row, false);
```

Also change every successful mocked probe to include the exact staged binding; a missing or inexact binding must make `viable` false.

- [ ] **Step 2: Run the candidate test and verify RED**

Run: `node --test tests/unit/app-server-candidates.test.js`

Expected: FAIL because the new launch fields do not exist and `spawnable` still exists.

- [ ] **Step 3: Implement the explicit candidate fields**

In `fingerprintCandidate`, compute and return:

```js
const stagedExecutable = result?.binding?.kind === "private-staged-snapshot"
  && result.binding.exact === true;
const directSpawnable = null;
const launchRecipe = stagedExecutable
  ? { kind: "private-staged-snapshot", requestedPath: candidate.path }
  : null;
const viable = versionOk && hashOk && stagedExecutable;
```

Return `stagedBinding: result?.binding ?? null`, remove `spawnable`, and use `directSpawnable: candidate.exists === false ? false : null` plus `stagedExecutable: false` for inaccessible candidates.

- [ ] **Step 4: Run the candidate test and verify GREEN**

Run: `node --test tests/unit/app-server-candidates.test.js`

Expected: all candidate tests PASS.

### Task 2: Add the owned staged resource factory

**Files:**
- Create: `tests/unit/staged-command-resource.test.js`
- Modify: `src/process/run-command.js`

- [ ] **Step 1: Write failing lifecycle tests**

Import `prepareStagedCommand` and cover normal exit, spawn error, abort, and repeated disposal. The normal path must assert the child-ready path differs from the original and is inside the binding directory:

```js
const resource = await prepareStagedCommand(process.execPath, { timeoutMs: 10_000 });
assert.notEqual(resource.executablePath, process.execPath);
assert.equal(resource.executablePath, resource.binding.files.find(({ role }) => role === "native").stagedPath);
const child = spawnCommand(resource.executablePath, ["-e", "setTimeout(() => {}, 50)"]);
await closeOf(child);
assert.equal(await pathExists(resource.stageDirectory), true);
await resource.dispose();
await resource.dispose();
assert.equal(await pathExists(resource.stageDirectory), false);
```

For a missing `cwd`, wait for both `error` and `close`, then dispose. For abort, kill a long-lived staged child from an `AbortController`, wait for `close`, then dispose. Each test must assert no new `codex-execution-snapshot-*` directory remains.

- [ ] **Step 2: Run the resource tests and verify RED**

Run: `node --test tests/unit/staged-command-resource.test.js`

Expected: FAIL because `prepareStagedCommand` is not exported.

- [ ] **Step 3: Implement `prepareStagedCommand`**

Add a preparation whitelist containing only `timeoutMs`, `deadlineAt`, and `signal`. Resolve and stage under one `OperationGuard`, verify the private binding, and return:

```js
{
  kind: "private-staged-command",
  requestedPath: executable,
  stageDirectory: staged.stageDirectory,
  executablePath: staged.executablePath,
  argvPrefix: Object.freeze([...staged.argvPrefix]),
  execution: staged.execution,
  binding: verifiedBinding,
  get disposed() { return disposed; },
  dispose,
}
```

`dispose` stores one promise, verifies the staged binding with a fresh bounded guard, always removes the exact private directory in `finally`, sets `disposed = true`, and either returns the final binding or throws `EIDENTITYCHANGED`. Preparation failures after staging always remove the exact private directory before rejecting.

- [ ] **Step 4: Run resource and run-command tests and verify GREEN**

Run: `node --test tests/unit/staged-command-resource.test.js tests/unit/run-command.test.js tests/unit/network-path.test.js`

Expected: all tests PASS and no staged directory remains.

### Task 3: Tighten generator exact-binding mocks and verify integration

**Files:**
- Modify: `tests/unit/app-server-schema-generator.test.js`
- Modify: `scripts/generate-app-server-schema.mjs`

- [ ] **Step 1: Require exact staged binding in generator tests**

Make the successful result helper include:

```js
binding: { kind: "private-staged-snapshot", exact: true }
```

Change the missing-identity regression to delete `binding` and expect `EIDENTITYMISSING`.

- [ ] **Step 2: Run the generator test and verify RED**

Run: `node --test tests/unit/app-server-schema-generator.test.js`

Expected: FAIL because a missing binding is still accepted.

- [ ] **Step 3: Require exact private staged binding**

In `requireSuccess`, reject unless:

```js
result.binding?.kind === "private-staged-snapshot" && result.binding.exact === true
```

Use `EIDENTITYMISSING` for absent or unsupported binding and retain `EIDENTITYCHANGED` for an explicitly false `identityStable` signal.

- [ ] **Step 4: Run focused and full verification**

Run:

```text
node --test tests/unit/run-command.test.js tests/unit/staged-command-resource.test.js tests/unit/network-path.test.js tests/unit/app-server-candidates.test.js tests/unit/app-server-schema-generator.test.js
node --test tests/unit/*.test.js
git diff --check
```

Expected: all tests PASS and `git diff --check` emits no output.

- [ ] **Step 5: Run safe real probes**

Run a real inventory/fingerprint probe and two fresh WindowsApps schema generations. Confirm package preference, `directSpawnable: null`, `stagedExecutable: true`, exact binding, stable execution/schema digests, and no `codex-execution-snapshot-*` or temporary publication directories.

- [ ] **Step 6: Create the required follow-up commit**

Stage only the Task 3 source, tests, and required skill documents, then commit once after fresh verification:

```text
git commit -m "fix: bind App Server launches to staged executables"
```
