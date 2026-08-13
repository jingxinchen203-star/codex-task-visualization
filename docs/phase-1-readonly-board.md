# Projectboard Phase 1 standalone read-only board

Phase 1 currently contains one deliberately narrow vertical slice: a standalone five-lane board built from Codex App Server thread metadata. It is useful for browsing and attention triage when the package App Server still matches the Phase 0 account identity. It does not activate the injected or write-capable product paths that Phase 0 rejected.

## Start the board

From the repository root:

```powershell
npm.cmd run board
```

The command searches `artifacts/phase-0/` from newest to oldest for a sealed report that authorizes standalone Phase 1. A specific report can be selected without changing it:

```powershell
npm.cmd run board -- --phase0-report artifacts\phase-0\<run-directory>
```

On success the command prints one `http://127.0.0.1:<random-port>/#<token>` URL. Open that exact URL in a browser. The fragment token is removed from the address bar before the board snapshot is fetched. The server listens only on loopback, uses a random port, loads no remote assets, returns no CORS permission, and stops with `Ctrl+C`.

## Start the Codex right-edge workspace

The read-only board can also launch together with the normal Codex desktop profile:

```powershell
npm.cmd run board:sidebar
```

Codex must be fully closed before this command starts. A Chromium debugging pipe is fixed at process launch, so an already-running desktop process cannot be upgraded in place. On Windows, use the versioned launcher from the repository root:

```powershell
Start-Codex-Projectboard.cmd
```

The launcher refuses to continue while `ChatGPT.exe` is already running. It deliberately keeps a console window attached to the controller: leave that window open while using the sidebar. If startup fails, the error remains visible instead of disappearing in a hidden process. The lower-level PowerShell entry is equivalent:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\start-projectboard-sidebar.ps1
```

The controller derives `ChatGPT.exe` only from the package helper selected by the Phase 0 identity lock. It passes exactly `--remote-debugging-pipe`: it does not open a TCP debug port and does not add `--user-data-dir`, so the official desktop app retains its normal signed-in profile. After the renderer is ready, the controller uses Codex's existing `electronBridge.sendMessageFromView` channel and the desktop app's already-authenticated App Server connection. Only `account/read` and paginated `thread/list` requests are accepted. Catalog reads use the App Server interactive-source default, fully paginate both active and archived results, and exclude internal subagent records. The returned account type must still match the sealed Phase 0 identity.

The sidebar board is an offline, scriptless `blob:` document. Its iframe has `allow-same-origin` only (no `allow-scripts`), its own CSP has `script-src 'none'` and `connect-src 'none'`, and it loads no remote assets. The parent controller reads only the static document's snapshot ID, five lane IDs, unique task IDs, and rendered count before accepting it. It does not execute board code in the Codex parent realm and does not bypass CSP. The right-edge handle expands the board over Codex's semantic main-content region while preserving the native left navigation; it never squeezes or resizes the app root. Collapsing the handle reveals the original conversation without losing its state. The controller rereads the catalog every 30 seconds and publishes only when the canonical snapshot identity changes. Keep the controller process running for automatic remount and refresh; it exits after the owned Codex process closes.

Renderer targets may be announced before they have a `body` or document element. The mount waits for a valid host, reuses healthy sessions across duplicate notifications, and remounts a missing frame before applying the current snapshot. “Mounted” means the loaded static document contains the exact snapshot ID, rendered task count, five canonical lanes, and a unique nonempty task ID for every source task; iframe load alone is never treated as success. Refreshes load and validate a hidden candidate iframe first, then atomically replace the prior frame. If a catalog, document, or validation step fails, the last acknowledged board remains visible and its timestamp is marked stale instead of being replaced by an unconfirmed candidate. A transient auxiliary renderer therefore cannot leave the working board empty or poison later refreshes.

The Quiet Ops workspace keeps the right-edge handle and Codex's native left navigation. Static task cards use the installed desktop application's own `codex://threads/<threadId>` read-only navigation address, so a user click can return to the original Codex task without starting a turn. Its five evidence-based lanes use only App Server facts, while the Phase 0 read-only No-Go boundary remains unchanged: the sidebar has no task write, model-turn, approval, archive, delete, Git, alternate-profile, or debug-port path.

This is a package-version-bound sidecar preview, not a documented Codex extension API. If OpenAI changes the preload bridge, target URL, package layout, account shape, or generated App Server schema, startup or refresh fails closed. It must not fall back to a PATH CLI, a debug TCP port, an internal database, or a write-capable method.

## Identity and upgrade rules

The board never chooses a bare PATH CLI.

1. It validates the Phase 0 report and `.report-sealed` marker.
2. It accepts only a report whose standalone Phase 1 decision is `go` or `go-with-readonly-degradation`.
3. It locates the exact package helper recorded by that report and fingerprints only that candidate.
4. If Windows has replaced the exact package version, it may select one—and only one—helper from the same `OpenAI.Codex` package family. This upgrade path is read-only only. The helper must be fingerprinted again and its own generated schema must match the fresh execution identity.
5. After connecting, `account/read` must return the same account type recorded in Phase 0. A mismatch fails with `EACCOUNTIDENTITY`; it is never rendered as an empty board and never falls back to a global CLI.

Package continuity authorizes no writes. A newly generated schema is used only to obtain the current `thread/list` source-kind enum and bind it to the selected helper bytes.

## App Server contract

Every successful catalog read is checked against this complete outbound allowlist:

- `initialize`
- `initialized`
- `account/read` with token refresh disabled
- `thread/list` for active and archived pagination

The session does not call `thread/read`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, approval methods, archive methods, or delete methods. The owned App Server must exit cleanly and its staging cleanup must succeed before a snapshot is returned.

## Projection semantics

The board intentionally does less than the eventual Phase 1 model rather than inventing facts:

- A normalized Windows `cwd` forms a provisional project identity. The UI labels the grouping as a work directory because repository-common-directory reconciliation is not implemented yet.
- The default **全部历史** projection combines every task returned by fully paginated active and archived `thread/list` calls. The standalone browser board can narrow the same immutable snapshot to one work directory; the CSP-compatible Codex sidebar deliberately renders the complete all-history projection without client-side controls. No task or model turn is created for either view.
- Active-catalog threads remain active Projectboard projections; archived-catalog threads retain an imported-archive marker. If the same thread appears in both catalogs, the active record wins and the task is counted once.
- Native threads with `status.type === "active"` appear in **执行中**.
- `idle`, `notLoaded`, and `systemError` threads appear in **收集箱**. A system error is an attention badge, not evidence that a task is planned or running.
- **已规划**, **待验收**, and **完成** start empty until the user makes a local Projectboard lane decision or independently sufficient facts exist. A local lane override changes only this board projection; it does not write the Codex task. Titles, name-less preview fallbacks, and next-action text are bounded; complete conversations and thread storage paths are not copied into the snapshot.
- `waitingOnApproval`, `waitingOnUserInput`, and `systemError` feed the compact **需要我处理** strip.

The expanded Codex main workspace uses five equal, full-height lanes at ordinary desktop widths, including the approximately 824 px content width produced by the native left navigation. In the scriptless sidebar, genuinely narrow viewports below 700 px stack the five lanes; the standalone browser board retains its state buttons and one-lane mobile view. Search, project selection, imported-archive filtering, and the task-detail dialog remain available in the standalone board. The sidebar keeps the same Quiet Ops typography, spacing, task metadata, light/dark colors, and reduced-motion styling while avoiding client-side execution entirely.

## Current boundary and known gaps

This slice does not yet persist a full local index, build ResumePackets, search full conversation bodies, or cache a catalog snapshot across controller restarts. The scriptless sidebar can navigate to the original task and persist bounded local lane decisions in `%LOCALAPPDATA%\CodexProjectboard\lane-overrides.v1.json`. Cards expose a click-based **移动到其他栏** control; drag-and-drop is intentionally not implemented. These local decisions alter only the Projectboard projection and never write Codex task state.

An externally spawned App Server from the current Windows package still returns no account identity and correctly fails with `EACCOUNTIDENTITY`. The sidebar does not weaken that check. It moves the same read-only catalog calls into the desktop renderer's existing authenticated bridge, then applies the original Phase 0 account-type lock before building a snapshot.

The sealed Phase 0 report remains historical evidence and is not rewritten. A separately authorized compatibility revalidation on 2026-08-11 established that the installed `OpenAI.Codex` renderer accepts one sandboxed `blob:` frame over `--remote-debugging-pipe`, without a debug port, task creation, model turn, network-security probe, or write. The HTTP iframe route remains no-go because the current Codex CSP blocks loopback framing. A later Codex CSP also blocks inline application code inherited by a `blob:` child; the sidebar therefore uses the stricter scriptless document described above rather than bypassing CSP or executing the child application in the parent realm. The installed Electron/Chrome build also exits with Windows code `0x80000003` after the probe calls `Browser.close`; the production controller therefore follows the desktop process lifetime and does not call `Browser.close` during normal operation.

Formal write injection remains no-go. The sidebar has no method for starting, resuming, steering, interrupting, archiving, deleting, approving, or editing a task. Phase 1 still needs an official host extension contract, or a new explicit gate, before any of those operations can be considered.

## Verification

The focused Phase 1 suite is:

```powershell
node --test tests/unit/phase1-*.test.js tests/integration/phase1-readonly-server.test.js
```

The changed shared JSONL initialization path is covered together with Phase 1 by:

```powershell
node --test tests/unit/jsonl-peer.test.js tests/unit/phase1-*.test.js tests/integration/phase1-readonly-server.test.js
```

The sidebar controller, authenticated bridge, offline document, and pipe mount are included in `tests/unit/phase1-*.test.js`, `tests/unit/cdp-targets.test.js`, and `tests/integration/cdp-pipe.test.js`.

Before committing, also run:

```powershell
npm.cmd test
git diff --check
```
