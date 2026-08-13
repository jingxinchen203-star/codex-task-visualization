import test from "node:test";
import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationGuard, createOwnedDirectory, identityOf } from "../../src/process/security-policy.js";

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function allocationEvidence(path) {
  return { path, originalIdentity: identityOf(await lstat(path, { bigint: true })) };
}

test("owned allocation never adopts a root replaced during allocation", async (t) => {
  const container = await mkdtemp(join(tmpdir(), "codex-root-allocation-race-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const root = join(container, "root");
  const displaced = join(container, "original-root");
  const sentinel = join(root, "replacement-sentinel.txt");
  await mkdir(root);
  const guard = new OperationGuard({ timeoutMs: 10_000 });
  t.after(() => guard.dispose());
  let rejection;

  await assert.rejects(
    createOwnedDirectory(root, "owned-", guard, {
      allocate: async (prefix) => {
        await rename(root, displaced);
        await mkdir(root);
        await writeFile(sentinel, "keep", "utf8");
        return allocationEvidence(await mkdtemp(prefix));
      },
    }),
    (error) => { rejection = error; return error.code === "EROOTIDENTITY"; },
  );

  assert.equal(await pathExists(sentinel), true);
  assert.equal(rejection.cleanup.attempted, false);
  assert.equal(rejection.cleanup.error.code, "EROOTIDENTITY");
});

test("owned allocation rejects a child replaced after allocator identity capture", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pre-capture-child-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let displaced;
  let sentinel;
  const guard = new OperationGuard({ timeoutMs: 10_000 });
  t.after(() => guard.dispose());
  let rejection;

  await assert.rejects(
    createOwnedDirectory(root, "owned-", guard, {
      allocate: async (prefix) => {
        const path = await mkdtemp(prefix);
        const evidence = await allocationEvidence(path);
        displaced = `${path}-original`;
        sentinel = join(path, "replacement-sentinel.txt");
        await rename(path, displaced);
        await mkdir(path);
        await writeFile(sentinel, "keep", "utf8");
        return evidence;
      },
    }),
    (error) => { rejection = error; return error.code === "EROOTIDENTITY"; },
  );

  assert.equal(await pathExists(displaced), true);
  assert.equal(await pathExists(sentinel), true);
  assert.equal(rejection.cleanup.attempted, true);
  assert.equal(rejection.cleanup.ok, false);
  assert.equal(rejection.cleanup.error.code, "EROOTIDENTITY");
});

test("owned allocation fails closed when allocator identity evidence is missing or invalid", async (t) => {
  const container = await mkdtemp(join(tmpdir(), "codex-allocation-evidence-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  for (const [name, originalIdentity] of [
    ["missing", undefined],
    ["invalid", { dev: "not-a-device", ino: null }],
  ]) {
    const root = join(container, name);
    await mkdir(root);
    const guard = new OperationGuard({ timeoutMs: 10_000 });
    try {
      let rejection;
      await assert.rejects(
        createOwnedDirectory(root, "owned-", guard, {
          allocate: async (prefix) => ({ path: await mkdtemp(prefix), originalIdentity }),
        }),
        (error) => { rejection = error; return error.code === "EALLOCATIONIDENTITY"; },
      );
      assert.equal(rejection.cleanup.attempted, false);
      assert.equal(rejection.cleanup.error.code, "EALLOCATIONIDENTITY");
    } finally {
      guard.dispose();
    }
  }
});

test("owned allocation never deletes a child replaced during permission setup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-child-allocation-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let displaced;
  let sentinel;
  const guard = new OperationGuard({ timeoutMs: 10_000 });
  t.after(() => guard.dispose());
  let rejection;

  await assert.rejects(
    createOwnedDirectory(root, "owned-", guard, {
      setMode: async (path) => {
        displaced = `${path}-original`;
        sentinel = join(path, "replacement-sentinel.txt");
        await rename(path, displaced);
        await mkdir(path);
        await writeFile(sentinel, "keep", "utf8");
      },
    }),
    (error) => { rejection = error; return error.code === "EROOTIDENTITY"; },
  );

  assert.equal(await pathExists(sentinel), true);
  assert.equal(await pathExists(displaced), true);
  assert.equal(rejection.cleanup.attempted, true);
  assert.equal(rejection.cleanup.ok, false);
  assert.equal(rejection.cleanup.error.code, "EROOTIDENTITY");
});
