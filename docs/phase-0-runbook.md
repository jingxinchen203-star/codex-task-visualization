# Projectboard Phase 0 runbook

This harness answers one question: which Codex integration paths are evidenced well enough to support a taskboard without guessing or silently broadening permissions?

## Default read-only run

```powershell
npm.cmd run probe
```

The default mode may collect Windows installation/process metadata, fingerprint discovered Codex binaries through private staged snapshots, generate and hash App Server schemas in an owned temporary directory, start an independent read-only App Server, list thread metadata, and run the local dispatch-recovery fixture. It does not restart or attach to the Codex desktop, create a task, start a model turn, answer an approval, archive a task, or delete a task.

Each run atomically publishes a new sealed directory under `artifacts/phase-0/`. It contains `report.json`, `summary.md`, and `.report-sealed`. Existing report directories are never replaced. Credentials, bearer values, nonces, prompts, and full task content are recursively redacted.

## Deliberately deferred gates

The current operating contract skips network/port/WebSocket security probing and Codex activation/injection probing. Accordingly, `secure_injection` and `local_api_security` are recorded as `skipped`; they are never coerced to pass. The flags `--allow-codex-restart` and `--probe-existing-instance` are reserved scope declarations for a later approved activation probe and are mutually exclusive. In this revision they do not activate, restart, attach to, or kill Codex.

## Live compatibility scope

Live mode is not part of the default run. Before it is used, show the user the exact selected candidate path, launcher/native hashes, execution digest, fixture directory, retained marker name, and this quota:

- exactly one persistent marker task;
- at most two short model turns;
- read-only sandbox policy;
- approvals are displayed as evidence and always answered `decline`;
- accepted turns are interrupted on every failed or inconclusive lifecycle path;
- no archive or delete operation exists in the harness.

Only after the user approves that concrete scope may the following shape be run:

```powershell
node src/cli.js live --allow-persistent-thread --allow-model-turns --fixture-cwd C:\tmp\projectboard-phase0
```

The fixture directory must be absolute. Persistent-thread and model-turn flags must be supplied together. The live probe creates the marker, then binds cross-process identity with an exact `thread/read` of the marker ID, name, non-ephemeral state, and zero turns before asking the operator to confirm the same task in the normal Codex UI. `thread/list` is not sufficient for this gate because a valid zero-turn task may be persisted but omitted from list results. Identity failure prevents both model-turn probes.

If a run stops after the marker was persisted, do not blindly start live mode again: that would spend the one-task quota a second time. Recovery may reuse only the exact Phase 0 marker after a fresh `thread/read` proves the expected name, non-ephemeral state, and zero turns. A recovered marker can never be accepted through list membership alone.

## Observed compatibility result (2026-08-10)

The approved live run used the package-bound `codex-cli 0.147.0-alpha.6.5` candidate with execution digest `9503b9b44930c5afbaa121e5d4af75439ce6b396a457b0d940cce4e2e12bae4a`. The marker was readable through a second independent App Server and through the normal Codex task backend, proving the package/App Server task identity without restarting or attaching to the desktop process.

Exactly one marker task and two accepted turns were used. The first turn reached `interrupted` without an assistant response or tool execution. The second reached `completed` without a command-execution item or approval request. The requested marker file was absent and the approval database contained zero records, so no permission was granted and no write was observed.

The runtime did not return the exact allowlisted active-turn conflict required by `double_write_control`, so that gate remains `fail`. The approval probe produced no approval request and is therefore `inconclusive`, not pass. Network, activation, and local-API security gates remain deliberately `skipped`. The resulting operating decision is:

- standalone read-only Phase 1: `go-with-readonly-degradation`;
- injected/write-capable Phase 1: `no-go`;
- Phase 2 execution: `no-go`;
- Phase 3: `blocked-by-git-gate`.

The conservative sealed live report has SHA-256 `f16da63abec1599e3174b042542468dd9135635a4eb5ec1a816be434a938019c`. It records the pre-fix terminal-settlement race as a failure; the regression tests now preserve terminal `thread/read` evidence instead of treating an already settled turn as an interrupt leak. No further model turn is permitted without a new explicit scope approval.

## Verdict semantics

- `pass` means the named gate produced its required evidence.
- `fail` preserves a concrete failed observation or lifecycle error.
- `inconclusive` means evidence was safe but insufficient.
- `skipped` means the probe was not enabled by the operating contract.

Only `pass` satisfies a dependent phase. Phase 1 standalone may degrade to read-only; injected Phase 1 remains No-Go while secure injection is skipped. Phase 2 remains No-Go until every execution gate passes. Phase 3 remains blocked by the separate Git/worktree gate.

## Verification commands

```powershell
node --test tests/unit/cli-arguments.test.js tests/unit/orchestrator.test.js tests/integration/report-output.test.js
npm.cmd test
git diff --check
```

Do not commit `artifacts/`, credentials, nonces, complete task content, user-specific absolute paths, or live fixture databases.
