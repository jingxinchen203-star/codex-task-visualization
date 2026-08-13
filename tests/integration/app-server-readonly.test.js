import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverCandidates, fingerprintCandidates } from "../../src/app-server/candidates.js";
import { readThreadSourceKinds } from "../../src/app-server/schema-contract.js";
import { probeAppServerIdentity } from "../../src/app-server/probe-readonly.js";

const binary = process.env.PROJECTBOARD_CODEX_BINARY;
const schemaDirectory = process.env.PROJECTBOARD_SCHEMA_DIR;

test("the selected App Server supports the read-only identity probe", { skip: !binary || !schemaDirectory, timeout: 60_000 }, async () => {
  const discovered = await discoverCandidates({
    package: null,
    commands: [{ kind: "Application", name: "PROJECTBOARD_CODEX_BINARY", source: binary, collector: "integration-env" }],
  });
  const exactCandidate = discovered.find(({ path }) => path === binary);
  assert.ok(exactCandidate, "the exact PROJECTBOARD_CODEX_BINARY candidate must be discovered");
  const [candidate] = await fingerprintCandidates([exactCandidate]);
  assert.equal(candidate.viable, true, candidate.fingerprintError ?? "candidate is not viable");
  const sourceKinds = await readThreadSourceKinds(schemaDirectory);
  const manifest = JSON.parse(await readFile(join(schemaDirectory, "binary-manifest.json"), "utf8"));
  assert.equal(manifest.executionDigest, candidate.executionDigest, "schema and launched candidate must have the same execution digest");
  assert.equal(manifest.version, candidate.version, "schema and launched candidate must have the same version");
  assert.deepEqual(manifest.sourceKinds, sourceKinds);

  const result = await probeAppServerIdentity(candidate, sourceKinds);
  assert.equal(result.initialized, true);
  assert.equal(typeof result.activeCount, "number");
  assert.equal(typeof result.archivedCount, "number");
  assert.equal(result.outboundMethods.includes("initialize"), true);
  assert.equal(result.outboundMethods.filter((method) => method === "thread/list").length >= 2, true);
  const readOnlyMethods = new Set(["initialize", "initialized", "account/read", "thread/list"]);
  assert.equal(result.outboundMethods.every((method) => readOnlyMethods.has(method)), true);
  for (const forbidden of ["thread/read", "thread/start", "turn/start", "thread/archive", "thread/delete"]) {
    assert.equal(result.outboundMethods.includes(forbidden), false);
  }
});
