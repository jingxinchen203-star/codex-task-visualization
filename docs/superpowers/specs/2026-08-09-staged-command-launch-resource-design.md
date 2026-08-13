# Staged Command Launch Resource Design

## Goal

Prevent candidate selection from treating a successful staged probe as evidence that the original executable path can be spawned directly. Downstream App Server launch code must request a fresh private staged snapshot and ask that owned resource to spawn exactly one child; staged filesystem paths are never public launch inputs.

## Contract

Candidate discovery produces a declarative recipe containing only durable identity and context expectations:

```js
{
  kind: "private-staged-snapshot",
  requestedPath,
  expectedExecutionDigest,
  expectedNativeSha256,
  expectedContextDigest,
}
```

`prepareStagedCommand(recipe, options)` resolves the requested command without shell parsing, validates lexical and canonical locality, constructs a controlled environment, validates and binds the working directory, copies every executable byte needed for launch into a private temporary directory, and rejects if the fresh execution, native, or context digest differs from the recipe. It returns an owned resource with no public staged path:

- `execution`, `executionContext`, and `binding`: immutable, path-sanitized evidence.
- `spawn(args)`: revalidates recipe identity and staged bytes immediately before launch, applies fixed piped stdio and the controlled environment, and may be called exactly once.
- `settlement`: structured child close/error/termination evidence.
- `dispose()`: refuses while the child is unsettled, then revalidates ownership and staged bytes before safe cleanup; repeated calls return the same result.

The resource is single-owner. A disposed resource cannot spawn. The caller never receives `stageDirectory`, `executablePath`, `argvPrefix`, or another mutable staging path. Spawn errors and aborts still settle the owned lifecycle before disposal.

Candidate fingerprints expose separate facts:

- `directSpawnable`: `true`, `false`, or `null` when direct launch was not attempted.
- `stagedExecutable`: whether a fresh staged snapshot was successfully probed with exact identity.
- `launchRecipe`: the durable recipe above, containing no staged path.
- `viable`: version, hashes, nonempty execution/native/context digests, internally consistent exact staged binding, `sourceStable === true`, and a supported launch recipe all succeeded.

The legacy ambiguous `spawnable` field is removed. A WindowsApps candidate that cannot be direct-spawned may remain viable through the staged recipe, but no consumer can mistake its original path for a child-ready executable.

## Lifecycle and Errors

Preparation and probes use a minimal allowlisted environment assembled from ambient values; arbitrary `env` passthrough is rejected and Node/code-loader injection variables are never inherited. The canonical working directory, controlled environment digest, and root identity form the execution-context digest.

Every executable, working directory, staging root, schema destination, and temporary path is checked lexically and canonically. UNC, device, symlink/junction/reparse targets, root replacement, and containment failures are rejected. Recursive cleanup and atomic publication first revalidate the process-owned root and child identity; on mismatch they do not delete or replace the unexpected object and retain structured cleanup evidence.

Preparation uses the same streaming hash/copy, option whitelist, deadline, and abort signal as command probes. `dispose()` is idempotent only after settlement and rejects premature disposal with `ECHILDACTIVE`.

Probe timeout/abort terminates the owned process tree. Windows uses a validated PID with narrowly scoped tree termination; other platforms terminate the owned child/process group. Results distinguish termination grace from `unsettled`. Staging is never deleted while an owned child may still be running. Exit/signal/stdout/stderr remain primary evidence even if post-verification or cleanup fails; those failures are returned in separate `postVerification` and `cleanup` outcomes.

An unsettled `runCommand()` result exposes one awaitable `settled` outcome. It performs post-verification and identity-verified deferred cleanup only after the child actually closes. Schema generation errors surface the same settlement and a single deferred-cleanup promise; if no observable settlement exists, the temporary schema root remains retained with explicit evidence.

Schema traversal is iterative and bounded by per-file bytes, aggregate bytes, file count, and maximum depth. JSON semantic hashing accepts only JSON whitespace (`SP`, `TAB`, `CR`, `LF`). Schema publication and cleanup use the same owned-root identity rules.

Task 4 will pass the selected durable recipe to `prepareStagedCommand()`, call `resource.spawn()` with App Server arguments, communicate over the fixed pipes, wait for settlement, and then call `dispose()`.

## Verification

Unit tests cover:

1. Explicit and inherited `NODE_OPTIONS` poisoning cannot execute a sentinel; execution evidence contains the controlled context digest.
2. Candidate viability fails closed for missing source stability, execution/native/context evidence, inconsistent binding, or recipe mismatch.
3. Lexical-local paths whose canonical target is a UNC/device/reparse path are rejected, including working, staging, and schema roots where platform support permits.
4. The owned resource exposes no staged launch path, revalidates immediately before its one spawn, detects mutation, and refuses premature disposal.
5. Timeout/abort settles a child and grandchild process tree, reports grace/unsettled evidence, and removes staging only after settlement.
6. Root replacement cannot redirect recursive deletion or schema publication; cleanup failure remains separate from process evidence.
7. Many-small-file, aggregate-byte, and deep-tree schema sets fail within fixed bounds and clean up safely.
8. Existing hostile-argument, bounded-output, identity, and real App Server probes remain green.
