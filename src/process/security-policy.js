import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const DEFAULT_TIMEOUT_MS = 30_000;

export function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
    code: error.code ?? null,
  };
}

export function rejectUnknownOptions(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw codedError("EUNSAFESPAWNOPTION", `Unsupported command option: ${key}`);
  }
}

export class OperationGuard {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, deadlineAt = null, signal = null } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
    if (deadlineAt !== null && !Number.isFinite(deadlineAt)) throw new TypeError("deadlineAt must be finite");
    this.controller = new AbortController();
    this.externalSignal = signal;
    this.deadlineAt = Math.min(Date.now() + timeoutMs, deadlineAt ?? Number.POSITIVE_INFINITY);
    this.kind = null;
    this.onExternalAbort = () => this.abort("aborted");
    if (signal?.aborted) this.abort("aborted");
    else signal?.addEventListener("abort", this.onExternalAbort, { once: true });
    this.timer = setTimeout(() => this.abort("timedOut"), Math.max(0, this.deadlineAt - Date.now()));
    this.timer.unref?.();
  }

  abort(kind) {
    if (this.kind) return;
    this.kind = kind;
    this.controller.abort(this.error());
  }

  error() {
    return this.kind === "aborted"
      ? codedError("ABORT_ERR", "The operation was aborted")
      : codedError("ETIMEDOUT", "The command operation deadline expired");
  }

  check() {
    if (!this.kind && Date.now() >= this.deadlineAt) this.abort("timedOut");
    if (this.kind) throw this.error();
  }

  async race(promise) {
    this.check();
    return new Promise((resolveRace, rejectRace) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.controller.signal.removeEventListener("abort", onAbort);
        callback(value);
      };
      const onAbort = () => finish(rejectRace, this.error());
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => finish(resolveRace, value),
        (error) => finish(rejectRace, this.kind ? this.error() : error),
      );
    });
  }

  dispose() {
    clearTimeout(this.timer);
    this.externalSignal?.removeEventListener("abort", this.onExternalAbort);
  }

  get signal() {
    return this.controller.signal;
  }
}

export function classifyExecutionPath(path) {
  if (typeof path !== "string" || path.length === 0) throw codedError("EINVALIDPATH", "Execution path must be a nonempty string");
  if (/^(?:\\\\|\/\/)/u.test(path)) {
    throw codedError("ENETWORKPATH", `Network and device paths are not allowed: ${path}`);
  }
  return "local";
}

export function identityOf(stats) {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  };
}

export function sameIdentity(left, right) {
  return Boolean(left && right) && Object.keys(left).every((key) => left[key] === right[key]);
}

function sameDirectoryIdentity(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

function pathEqual(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function assertContained(root, child) {
  const relation = relative(root, child);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw codedError("EPATHESCAPE", `Path is not a strict child of its owned root: ${child}`);
  }
}

async function rejectReparseComponents(absolutePath, guard) {
  const parsed = parse(absolutePath);
  const components = absolutePath.slice(parsed.root.length).split(/[\\/]+/u).filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = join(current, component);
    let stats;
    try {
      stats = await guard.race(lstat(current, { bigint: true }));
    } catch (error) {
      if (error.code === "ENOENT") throw error;
      throw error;
    }
    if (stats.isSymbolicLink()) throw codedError("EREPARSEPATH", `Reparse and symbolic-link paths are not allowed: ${current}`);
  }
}

export async function validateLocalPath(path, { guard, kind = "any" } = {}) {
  guard.check();
  classifyExecutionPath(path);
  const lexicalPath = resolve(path);
  classifyExecutionPath(lexicalPath);
  await rejectReparseComponents(lexicalPath, guard);
  const canonicalPath = await guard.race(realpath(lexicalPath));
  classifyExecutionPath(canonicalPath);
  const stats = await guard.race(stat(canonicalPath, { bigint: true }));
  if (kind === "directory" && !stats.isDirectory()) throw codedError("ENOTDIR", `Expected a directory: ${path}`);
  if (kind === "file" && !stats.isFile()) throw codedError("ENOTFILE", `Expected a file: ${path}`);
  return { lexicalPath, canonicalPath, identity: identityOf(stats), kind };
}

export async function ensureLocalDirectory(path, guard) {
  classifyExecutionPath(path);
  const target = resolve(path);
  classifyExecutionPath(target);
  const missing = [];
  let current = target;
  let evidence;
  while (!evidence) {
    try {
      evidence = await validateLocalPath(current, { guard, kind: "directory" });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
  for (const name of missing.reverse()) {
    guard.check();
    const next = join(evidence.canonicalPath, name);
    try {
      await guard.race(mkdir(next, { mode: 0o700 }));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    evidence = await validateLocalPath(next, { guard, kind: "directory" });
  }
  return evidence;
}

const WINDOWS_ENV_ALLOWLIST = [
  "SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH", "USERNAME",
  "LANG", "LC_ALL", "NO_COLOR",
];
const POSIX_ENV_ALLOWLIST = [
  "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
];

function inheritedEnvironmentValue(name) {
  if (process.platform !== "win32") return process.env[name];
  const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

export function controlledEnvironment() {
  const environment = Object.create(null);
  const allowlist = process.platform === "win32" ? WINDOWS_ENV_ALLOWLIST : POSIX_ENV_ALLOWLIST;
  for (const name of allowlist) {
    const value = inheritedEnvironmentValue(name);
    if (typeof value !== "string" || value.length === 0) continue;
    if (value.includes("\0")) throw codedError("EUNSAFEENV", `Environment value contains NUL: ${name}`);
    environment[name] = value;
  }
  const entries = Object.entries(environment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const digest = createHash("sha256");
  for (const [key, value] of entries) digest.update(`${key.toUpperCase()}\0${value}\n`);
  return { environment, environmentDigest: digest.digest("hex"), environmentKeys: entries.map(([key]) => key) };
}

export async function createExecutionContext({ cwd = process.cwd(), guard }) {
  const cwdEvidence = await validateLocalPath(cwd, { guard, kind: "directory" });
  const cwdIdentity = { dev: cwdEvidence.identity.dev, ino: cwdEvidence.identity.ino };
  const controlled = controlledEnvironment();
  const digest = createHash("sha256");
  digest.update(`${cwdEvidence.canonicalPath}\0${JSON.stringify(cwdIdentity)}\0${controlled.environmentDigest}`);
  return {
    cwd: cwdEvidence.canonicalPath,
    cwdIdentity,
    environment: controlled.environment,
    environmentDigest: controlled.environmentDigest,
    environmentKeys: controlled.environmentKeys,
    contextDigest: digest.digest("hex"),
  };
}

export function publicExecutionContext(context) {
  return Object.freeze({
    cwd: context.cwd,
    cwdIdentity: Object.freeze({ ...context.cwdIdentity }),
    environmentDigest: context.environmentDigest,
    environmentKeys: Object.freeze([...context.environmentKeys]),
    contextDigest: context.contextDigest,
  });
}

export async function captureOwnedRoot(path, guard) {
  const evidence = await validateLocalPath(path, { guard, kind: "directory" });
  return { path: evidence.canonicalPath, canonicalPath: evidence.canonicalPath, identity: evidence.identity };
}

async function currentDirectoryIdentity(path, guard) {
  const stats = await guard.race(lstat(path, { bigint: true }));
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw codedError("EROOTIDENTITY", `Owned directory became a reparse point or non-directory: ${path}`);
  return identityOf(stats);
}

async function verifyOwnedRoot(root, guard) {
  const identity = await currentDirectoryIdentity(root.canonicalPath, guard);
  if (!sameDirectoryIdentity(identity, root.identity)) {
    throw codedError("EROOTIDENTITY", `Owned root identity changed: ${root.canonicalPath}`);
  }
  const canonicalPath = await guard.race(realpath(root.canonicalPath));
  classifyExecutionPath(canonicalPath);
  if (!pathEqual(canonicalPath, root.canonicalPath)) {
    throw codedError("EROOTIDENTITY", `Owned root canonical path changed: ${root.canonicalPath}`);
  }
}

export async function verifyOwnedDirectory(owned, guard) {
  await verifyOwnedRoot(owned.root, guard);
  const childIdentity = await currentDirectoryIdentity(owned.canonicalPath, guard);
  if (!sameDirectoryIdentity(childIdentity, owned.identity)) throw codedError("EROOTIDENTITY", `Owned directory identity changed: ${owned.canonicalPath}`);
  const canonicalPath = await guard.race(realpath(owned.canonicalPath));
  classifyExecutionPath(canonicalPath);
  if (!pathEqual(canonicalPath, owned.canonicalPath)) throw codedError("EROOTIDENTITY", `Owned directory canonical path changed: ${owned.canonicalPath}`);
  assertContained(owned.root.canonicalPath, canonicalPath);
  return true;
}

const IDENTITY_FIELDS = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];

function ownedFromAllocation(root, allocation) {
  const validIdentity = allocation?.originalIdentity
    && IDENTITY_FIELDS.every((field) => typeof allocation.originalIdentity[field] === "string"
      && /^-?[0-9]+$/u.test(allocation.originalIdentity[field]));
  if (typeof allocation?.path !== "string" || allocation.path.length === 0 || !validIdentity) {
    throw codedError("EALLOCATIONIDENTITY", "Owned directory allocator did not return valid original identity evidence");
  }
  classifyExecutionPath(allocation.path);
  const lexicalPath = resolve(allocation.path);
  assertContained(root.canonicalPath, lexicalPath);
  return {
    root,
    path: lexicalPath,
    canonicalPath: lexicalPath,
    identity: { ...allocation.originalIdentity },
  };
}

async function verifyAllocatedChild(owned, guard) {
  const stats = await guard.race(lstat(owned.canonicalPath, { bigint: true }));
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw codedError("EROOTIDENTITY", `Allocated child is a reparse point or non-directory: ${owned.canonicalPath}`);
  }
  if (!sameDirectoryIdentity(identityOf(stats), owned.identity)) {
    throw codedError("EROOTIDENTITY", `Allocated child identity changed before ownership validation: ${owned.canonicalPath}`);
  }
  const canonicalPath = await guard.race(realpath(owned.canonicalPath));
  classifyExecutionPath(canonicalPath);
  if (!pathEqual(canonicalPath, owned.canonicalPath)) {
    throw codedError("EROOTIDENTITY", `Allocated child canonical path changed: ${owned.canonicalPath}`);
  }
  assertContained(owned.root.canonicalPath, canonicalPath);
  await verifyOwnedDirectory(owned, guard);
}

async function allocateOwnedDirectory(prefix, guard) {
  const path = await guard.race(mkdtemp(prefix));
  const stats = await guard.race(lstat(path, { bigint: true }));
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw codedError("EALLOCATIONIDENTITY", `Allocator created a reparse point or non-directory: ${path}`);
  }
  return { path, originalIdentity: identityOf(stats) };
}

export async function createOwnedDirectory(rootPath, prefix, guard, operations = {}) {
  const allocate = operations.allocate ?? allocateOwnedDirectory;
  const setMode = operations.setMode ?? chmod;
  const root = await captureOwnedRoot(rootPath, guard);
  await verifyOwnedRoot(root, guard);
  let owned = null;
  try {
    const allocation = await guard.race(allocate(join(root.canonicalPath, prefix), guard));
    await verifyOwnedRoot(root, guard);
    owned = ownedFromAllocation(root, allocation);
    await verifyAllocatedChild(owned, guard);
    await guard.race(setMode(owned.canonicalPath, 0o700));
    await verifyOwnedDirectory(owned, guard);
    return owned;
  } catch (error) {
    error.cleanup = owned
      ? await safeRemoveOwnedDirectory(owned)
      : { attempted: false, ok: false, error: serializeError(error) };
    throw error;
  }
}

export async function safeRemoveOwnedDirectory(owned, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const guard = new OperationGuard({ timeoutMs });
  try {
    await verifyOwnedDirectory(owned, guard);
    await guard.race(rm(owned.canonicalPath, { recursive: true, force: true }));
    return { attempted: true, ok: true, error: null };
  } catch (error) {
    return { attempted: true, ok: false, error: serializeError(error) };
  } finally {
    guard.dispose();
  }
}
