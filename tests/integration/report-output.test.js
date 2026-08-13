import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeReport } from "../../src/report/write-report.js";

function sampleReport(runId = "run") {
  return {
    schemaVersion: 1,
    runId,
    gates: [{
      id: "probe",
      status: "pass",
      evidence: [{
        bearer: "secret-value",
        bootstrapNonce: "one-shot",
        authorizationHeader: "Bearer abc.def",
        apiKey: "api-key-secret",
        privateKey: "private-key-secret",
        prompt: "private prompt",
        thread: { content: "private thread content", body: "private thread body", id: "thread-visible" },
        safe: "visible",
      }],
      notes: [],
    }],
    phases: { standalonePhase1: "go" },
    redactions: ["bearer", "nonce", "prompt", "full-thread-content"],
  };
}

test("report is atomically published, sealed, and redacts secrets", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "projectboard-phase0-report-"));
  const directory = path.join(parent, "run");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const written = await writeReport(directory, sampleReport());
  assert.equal(written.directory, await realpath(directory));
  const report = await readFile(path.join(directory, "report.json"), "utf8");
  for (const secret of [
    "secret-value",
    "one-shot",
    "abc.def",
    "api-key-secret",
    "private-key-secret",
    "private prompt",
    "private thread content",
    "private thread body",
  ]) {
    assert.equal(report.includes(secret), false);
  }
  assert.equal(report.includes("visible"), true);
  assert.equal(report.includes("thread-visible"), true);
  assert.equal((await readFile(path.join(directory, "summary.md"), "utf8")).includes("# Phase 0 Compatibility Report"), true);
  assert.equal((await readFile(path.join(directory, ".report-sealed"), "utf8")).trim(), "run");
  await assert.rejects(() => writeReport(directory, sampleReport("overwrite")), /exist|sealed/u);
});

test("concurrent publication has one winner and never replaces it", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "projectboard-phase0-race-"));
  const directory = path.join(parent, "run");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const outcomes = await Promise.allSettled([
    writeReport(directory, sampleReport("first")),
    writeReport(directory, sampleReport("second")),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  const published = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"));
  assert.ok(["first", "second"].includes(published.runId));
  assert.equal((await readFile(path.join(directory, ".report-sealed"), "utf8")).trim(), published.runId);
  assert.deepEqual(await readdir(parent), ["run"]);
});

test("serialization failure leaves no final report directory", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "projectboard-phase0-failure-"));
  const directory = path.join(parent, "run");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const report = sampleReport();
  report.gates[0].evidence[0].cycle = report;
  await assert.rejects(() => writeReport(directory, report), /cycle|serializ/u);
  await assert.rejects(() => access(directory), /ENOENT/u);
  assert.deepEqual(await readdir(parent), []);
});

test("a timed-out file mutation settles before owned cleanup begins", { timeout: 2_000 }, async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "projectboard-phase0-slow-write-"));
  const directory = path.join(parent, "run");
  t.after(() => rm(parent, { recursive: true, force: true }));
  let releaseWrite;
  let signalWrite;
  const writeStarted = new Promise((resolve) => { signalWrite = resolve; });
  const writeReleased = new Promise((resolve) => { releaseWrite = resolve; });
  const publication = writeReport(directory, sampleReport(), {
    timeoutMs: 100,
    writeFileImpl: async (file, ...args) => {
      if (path.basename(file) === "report.json") {
        signalWrite();
        await writeReleased;
      }
      return writeFile(file, ...args);
    },
  });
  await writeStarted;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await Promise.race([publication.then(() => "done", () => "failed"), Promise.resolve("pending")]), "pending");
  releaseWrite();
  await assert.rejects(publication, (error) => error.code === "ETIMEDOUT");
  assert.deepEqual(await readdir(parent), []);
});

test("a rename that finishes after the deadline is reconciled as published", { timeout: 2_000 }, async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "projectboard-phase0-slow-rename-"));
  const directory = path.join(parent, "run");
  t.after(() => rm(parent, { recursive: true, force: true }));
  let releaseRename;
  let signalRename;
  const renameStarted = new Promise((resolve) => { signalRename = resolve; });
  const renameReleased = new Promise((resolve) => { releaseRename = resolve; });
  const publication = writeReport(directory, sampleReport(), {
    timeoutMs: 100,
    renameImpl: async (...args) => {
      signalRename();
      await renameReleased;
      return rename(...args);
    },
  });
  await renameStarted;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await Promise.race([publication.then(() => "done", () => "failed"), Promise.resolve("pending")]), "pending");
  releaseRename();
  const written = await publication;
  assert.equal(written.directory, await realpath(directory));
  assert.equal((await readFile(path.join(directory, ".report-sealed"), "utf8")).trim(), "run");
  assert.deepEqual(await readdir(parent), ["run"]);
});
