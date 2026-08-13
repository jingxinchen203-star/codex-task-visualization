# Projectboard Phase 1 — Quiet Ops read-only redesign

Date: 2026-08-11

## Outcome

Replace the current generic sidebar surface with the approved **Quiet Ops / 安静的工作台** five-lane workspace and make the authenticated Codex conversation catalog provably reach the rendered board.

The right-edge Projectboard handle remains the daily entry point. Expanding it overlays the semantic Codex main-content region while preserving the native left navigation. The board remains read-only and does not broaden any Phase 0 permission or integration decision.

## Evidence and design basis

The current controller has reported a non-empty catalog while the visible frame has remained on its static loading shell. Codex's normal read-only task directory also returns real current and historical tasks. The defect therefore has two separately testable boundaries:

1. select the complete user-visible interactive conversation catalog; and
2. prove that the sandboxed application has parsed and rendered the exact snapshot supplied by the controller.

The visual direction follows OpenDesign's context-first and committed-aesthetic guidance: match the host application's density, choose one restrained accent, establish a deliberate type hierarchy, and avoid generic rounded-card and badge-heavy dashboard styling. No OpenDesign runtime or plugin is added to the product.

## Scope

This increment includes:

- the Quiet Ops visual system and five-lane workspace;
- the aggregate all-history view, work-directory filter, search, and archive filter;
- fully paginated active and archived interactive thread metadata;
- catalog deduplication by thread ID;
- an initial snapshot embedded into the offline document;
- application-ready and snapshot-applied acknowledgements;
- last-good-snapshot retention and automatic remount;
- offline, unit, integration, responsive, and visual verification.

This increment excludes:

- reading complete turns or conversation bodies;
- inventing planned, review, or done states from titles or previews;
- creating, resuming, steering, interrupting, archiving, deleting, approving, or editing a Codex task;
- writing Git state through the board;
- opening a debugging TCP port;
- repeating Phase 0 live probes, creating validation tasks, consuming model turns, or completing the deliberately skipped network-security tests;
- adding a local state database, write-capable injection path, or undocumented deep link.

## Catalog contract

### Identity and allowed methods

The controller continues to bind the installed package helper, execution identity, generated schema, and account type through the existing Phase 0 identity lock. The renderer bridge accepts only:

- `account/read` with token refresh disabled;
- `thread/list`.

Every outbound method is recorded and validated. Any other method fails closed.

### User-visible sources

The read request explicitly uses the App Server schema's interactive-source behavior by supplying an empty `sourceKinds` array. The generated schema currently defines an omitted or empty filter as the interactive default. The identity lock still verifies the complete generated enum, but internal subagent source kinds are not requested for the user-facing board.

This choice targets the conversations a user sees as Codex tasks instead of mixing them with internal subagent execution records.

### Pagination and deduplication

Active and archived catalogs are read separately with:

- `limit: 100`;
- `sortKey: "updated_at"`;
- `sortDirection: "desc"`;
- a null initial cursor;
- continued requests until `nextCursor` is null;
- rejection of empty, malformed, or repeated non-null cursors;
- the existing bounded maximum-page guard.

A page containing 100 rows is not treated as complete unless the server also returns a null `nextCursor`. Tests must cover catalogs larger than one page for both active and archived reads.

Threads are merged through a stable ID map. If the same ID appears in both collections, the active record wins and the duplicate archived record is ignored. The final unique source count, projected task count, aggregate task count, and rendered task count must agree.

### Projection

The board continues to group threads by normalized `cwd` and defaults to an `all-history` aggregate. Only bounded metadata is projected:

- thread ID;
- name or bounded preview fallback;
- normalized work directory;
- created and updated timestamps;
- native status and active flags;
- archived membership.

Native `active` threads appear in **执行中**. `idle`, `notLoaded`, and `systemError` appear in **收集箱**. Waiting flags and system errors feed the compact attention rail. **已规划**, **待验收**, and **完成** remain empty until a future approved source provides durable evidence.

## Snapshot delivery and acknowledgement

### Snapshot identity

Each immutable board snapshot receives a controller-generated `snapshotId` derived from a canonical SHA-256 representation of the bounded projected metadata. The identifier contains no credential or full conversation content.

`sourceTaskCount` means the unique post-deduplication catalog count. `renderedTaskCount` means the number of unique task IDs present in the rendered aggregate lanes.

The same snapshot is:

1. embedded into the initial offline document;
2. retained by the controller as the last known good snapshot; and
3. used for later refresh messages.

### Initial boot

The application script remains after the body markup and boots from `globalThis.__PROJECTBOARD_SNAPSHOT__`. After validation and rendering, the sandboxed application posts a strict message to its parent:

```text
projectboard-readonly-ready
snapshotId
sourceTaskCount
renderedTaskCount
```

The parent mount expression listens only for a message whose `source` is the created frame's `contentWindow`, whose type is exact, and whose snapshot ID and counts match the expected snapshot. An iframe `load` event alone is insufficient. A mismatch, script error, or timeout means the target was not mounted.

### Refresh

Each refresh carries a unique `updateId`, the new snapshot, and its `snapshotId`. The application validates and renders the snapshot, then replies with:

```text
projectboard-readonly-applied
updateId
snapshotId
sourceTaskCount
renderedTaskCount
```

The parent update expression waits for this acknowledgement before reporting success. Posting a message without application acknowledgement is not success.

If a catalog refresh fails, the controller keeps the last good snapshot visible and reports a stale-data state. If the frame is missing, the controller remounts it with that snapshot. A healthy target cannot be poisoned by a transient auxiliary renderer.

### Embedded security policy

The embedded document remains an offline `blob:` document in `sandbox="allow-scripts"` with no same-origin permission, forms, popups, downloads, or top-navigation capability. Its content security policy keeps remote connections, objects, forms, base URLs, and remote assets disabled.

The contradictory `frame-ancestors 'none'` directive is removed from the embedded meta policy because this document is intentionally framed. The standalone HTTP response retains its anti-framing policy. This change does not add network access or remove the iframe sandbox.

## Quiet Ops visual system

### Layout

At ordinary Codex desktop widths, including approximately 824 by 752 pixels:

- retain the native left navigation;
- use the right-edge handle only as the expand/collapse control;
- give the remaining main region to one continuous board surface;
- show a single compact top row containing the title, real catalog summary, project selector, search, and archive toggle;
- place one compact attention rail below it;
- divide the remaining height into five equal lanes;
- keep lane headers fixed while their task lists scroll independently.

Below 700 pixels, five state tabs replace simultaneous columns and expose one lane at a time. The page must not produce whole-workspace horizontal overflow.

### Visual language

The approved palette is warm neutral:

- warm gray application surface;
- white task surfaces;
- fine neutral separators;
- near-black primary text;
- muted gray metadata;
- one orange-red accent used only for active work, attention, focus, and selected state.

Under the host's dark preference, the same hierarchy shifts to warm charcoal surfaces, pale neutral text, and subdued dark separators while retaining the single orange-red accent. Dark mode is an adaptation of Quiet Ops, not a second visual direction.

The UI uses locally available `Segoe UI Variable` and `Microsoft YaHei UI`, with a restrained monospace face for IDs and compact status metadata. It loads no remote font or asset.

Cards use tight spacing, small radii, and almost no shadow. The design avoids gradients, decorative illustration, emoji icons, excessive pills, colored left-border card templates, detached statistic tiles, and redundant safety chrome.

### Content hierarchy

The header answers four questions immediately:

1. what surface is open;
2. how many real conversations were loaded;
3. which project scope is selected; and
4. whether the snapshot is current or stale.

Task cards show the title, compact source/time metadata, project origin in aggregate view, and attention or archive facts only when present. Empty evidence-based lanes explain the read-only limitation in one quiet sentence rather than filling the space with placeholder cards.

Task activation opens only the existing local read-only detail dialog. Collapse restores the original Codex conversation without reloading or resizing the app root.

## Error behavior

The UI never converts these conditions into an empty success state:

- account identity mismatch;
- malformed catalog page or thread metadata;
- pagination cursor failure;
- projected and rendered count mismatch;
- embedded application boot failure;
- snapshot acknowledgement timeout;
- renderer remount failure.

Before the first good snapshot, the board shows a concise diagnostic surface. After a good snapshot, refresh errors preserve the board and mark it stale. Controller logs name the failed boundary and retain no credential, prompt, full preview, or complete task content.

## Test design

### Catalog tests

- More than 100 active and more than 100 archived threads traverse every cursor.
- An empty source filter is sent and internal subagent source kinds are not enumerated into the request.
- Repeated and malformed cursors fail closed.
- Cross-collection duplicates resolve to the active thread.
- Source, projection, aggregate, and summary counts agree.

### Embedded application tests

- A non-empty initial snapshot is applied after the DOM exists.
- Ready acknowledgement contains the exact snapshot ID and matching counts.
- A refresh sends an applied acknowledgement only after rendering.
- Invalid snapshots and count mismatches fail visibly.
- The embedded policy has no network capability and remains compatible with intentional sandbox framing.

### Controller tests

- Frame `load` without application readiness is not mounted.
- Ready or applied acknowledgement with the wrong frame, ID, or count is rejected.
- Missing frames remount from the last good snapshot.
- Refresh failure preserves the working snapshot and later recovery clears stale state.
- Duplicate target notifications reuse healthy sessions.

### UI and visual tests

- `all-history` is the default and every supplied task remains searchable.
- Five equal lanes fit the approximately 824 by 752 Codex main region.
- Wide desktop and sub-700-pixel layouts remain usable.
- Keyboard focus, dialog operation, reduced motion, light/dark host contrast, and independent lane scrolling remain accessible.
- A local visual capture is compared against the approved Quiet Ops direction before handoff.

### Repository verification

Run the focused Phase 1 and shared transport suites, the complete test suite, `git diff --check`, and a final code review. No Phase 0 live probe, task creation, model turn, skipped network test, or debug TCP port is part of verification.

## Acceptance

The increment is accepted when one final safe restart shows all of the following:

1. the right-edge handle opens the Quiet Ops five-lane workspace;
2. the controller's catalog count equals the header and rendered aggregate counts;
3. the current “继续实现只读五栏看板” task is discoverable;
4. the initial board is populated without waiting for a later refresh;
5. five lanes fit the Codex main region without workspace horizontal overflow;
6. collapse returns to the original conversation intact;
7. no task, model turn, approval, task state, Git state, or debug TCP listener was created or changed by the board.
