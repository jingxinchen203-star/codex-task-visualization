# Projectboard Phase 1 — Right-edge workspace amendment

Date: 2026-08-11

## Decision

Keep the existing right-edge Projectboard toggle because it is the most convenient entry point in the daily Codex window. Opening the toggle must present the approved Codex-native, five-lane workspace design instead of a narrow permanent drawer.

The toggle is an entry and collapse control, not the board's content boundary. When expanded, the read-only board overlays the Codex main content region while preserving the native left navigation. When collapsed, the original Codex content is revealed without navigation or conversation state loss.

## Expanded layout

- Use the semantic Codex `main` region as the preferred workspace boundary, with a fail-safe full-root fallback.
- Do not resize the Codex root or permanently squeeze the current conversation.
- Keep the right-edge toggle visible above the board in both expanded and collapsed states.
- Use the approved compact native styling: quiet surfaces, fine separators, dense cards, and five equal full-height lanes.
- Remove the permanent in-board project sidebar. Put project selection in the board toolbar so all horizontal space belongs to the lanes.
- Default to an aggregate `全部历史` view, then allow selection of each workspace project.
- Keep all interactions read-only: search, filters, project selection, lane tabs at genuinely narrow widths, and local task detail inspection only.

## Historical catalog behavior

- Read every active and archived thread returned by fully paginated `thread/list` for every source kind sealed by Phase 0.
- Do not fetch full turns, create placeholder tasks, create model turns, or write thread/Git state.
- Show the aggregate task total immediately. The initial embedded snapshot must render without requiring a later refresh message.
- Preserve honest state projection: metadata that cannot prove planned, review, or done remains in the inbox rather than being invented.
- Archived source threads remain visible when the archive filter is enabled and are labeled as archived imports.

## Reliability requirements

- The embedded application script must execute only after its DOM exists.
- Renderer mounting must wait for `document.body` or `document.documentElement` instead of calling `appendChild` on `null`.
- A target is recorded as mounted only after the frame loads successfully.
- Duplicate target notifications reuse an existing session.
- A refresh that finds a missing frame remounts it and then applies the current snapshot.
- One transient renderer must not poison refreshes for the working Codex renderer.

## Acceptance evidence

1. A composed embedded document places the application script after the body markup and boots from a non-empty snapshot.
2. A mount expression survives a renderer whose DOM host appears after target discovery.
3. Controller tests prove failed mounts are not retained and missing frames are remounted on refresh.
4. UI tests prove `全部历史` is the default and all supplied tasks remain discoverable.
5. The targeted suite, full suite, code review, and a safe live visual check pass before commit.
