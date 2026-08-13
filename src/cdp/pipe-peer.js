import { EventEmitter } from "node:events";

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_HISTORY = 256;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function asError(value, fallback) {
  if (value instanceof Error) return value;
  return new Error(typeof value?.message === "string" ? value.message : fallback);
}

function protocolError(message, cause) {
  const error = new Error(`CDP pipe protocol error: ${message}`, cause ? { cause } : undefined);
  error.code = "EPROTOCOL";
  return error;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
}

export class CdpPipePeer extends EventEmitter {
  constructor(input, output, {
    child = null,
    maxInboundFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    maxOutboundHistory = DEFAULT_MAX_HISTORY,
  } = {}) {
    super();
    if (!input?.on || !output?.on || typeof output.write !== "function") {
      throw new TypeError("input and output must be Node streams");
    }
    positiveInteger(maxInboundFrameBytes, "maxInboundFrameBytes");
    positiveInteger(maxOutboundHistory, "maxOutboundHistory");

    this.input = input;
    this.output = output;
    this.outbound = [];
    this.notifications = [];
    this._maxInboundFrameBytes = maxInboundFrameBytes;
    this._maxOutboundHistory = maxOutboundHistory;
    this._frame = Buffer.alloc(0);
    this._pending = new Map();
    this._activeWrites = new Set();
    this._writeTail = Promise.resolve();
    this._nextId = 1;
    this._terminalError = null;

    input.on("data", (chunk) => this._onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    input.on("error", (error) => this._fail(asError(error, "CDP input failed")));
    input.on("end", () => this._fail(new Error("CDP input closed")));
    input.on("close", () => this._fail(new Error("CDP input closed")));
    output.on("error", (error) => this._fail(asError(error, "CDP output failed")));
    output.on("close", () => this._fail(new Error("CDP output closed")));
    if (child?.on) {
      child.on("error", (error) => this._fail(asError(error, "CDP child failed")));
      child.on("close", (code, signal) => {
        const suffix = signal ? ` (${signal})` : Number.isInteger(code) ? ` (code ${code})` : "";
        this._fail(new Error(`CDP child closed${suffix}`));
      });
    }
  }

  get pendingCount() { return this._pending.size; }

  get activeWriteCount() { return this._activeWrites.size; }

  request(method, params = {}, { sessionId, timeoutMs = 15_000 } = {}) {
    if (typeof method !== "string" || method.length === 0) throw new TypeError("method must be a nonempty string");
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length === 0)) {
      throw new TypeError("sessionId must be a nonempty string");
    }
    positiveInteger(timeoutMs, "timeoutMs");
    if (this._terminalError) return Promise.reject(this._terminalError);

    const id = this._nextId;
    this._nextId += 1;
    let resolveRequest;
    let rejectRequest;
    const result = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const timer = setTimeout(() => {
      const pending = this._pending.get(id);
      if (!pending) return;
      const error = new Error(`CDP request ${method} timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      this._fail(error);
    }, timeoutMs);
    timer.unref?.();
    this._pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timer });

    const message = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    this._send(message, () => this._pending.has(id)).catch((error) => this._fail(error));
    return result;
  }

  _remember(message) {
    this.outbound.push(structuredClone(message));
    if (this.outbound.length > this._maxOutboundHistory) {
      this.outbound.splice(0, this.outbound.length - this._maxOutboundHistory);
    }
  }

  _send(message, shouldWrite) {
    let bytes;
    try {
      bytes = Buffer.concat([Buffer.from(JSON.stringify(message), "utf8"), Buffer.from([0])]);
    } catch (error) {
      return Promise.reject(error);
    }
    const write = () => new Promise((resolve, reject) => {
      if (!shouldWrite() || this._terminalError) {
        if (this._terminalError) reject(this._terminalError);
        else resolve();
        return;
      }
      if (this.output.destroyed || this.output.writableEnded) {
        reject(new Error("CDP output is closed"));
        return;
      }
      let settled = false;
      const active = {
        settle: (error) => {
          if (settled) return;
          settled = true;
          this._activeWrites.delete(active);
          if (error) reject(asError(error, "CDP output write failed"));
          else resolve();
        },
      };
      this._activeWrites.add(active);
      try {
        this._remember(message);
        this.output.write(bytes, active.settle);
      } catch (error) {
        active.settle(error);
      }
    });
    const current = this._writeTail.then(write);
    this._writeTail = current.catch(() => {});
    return current;
  }

  _onData(chunk) {
    if (this._terminalError) return;
    let remaining = chunk;
    while (!this._terminalError) {
      const delimiter = remaining.indexOf(0);
      const fragment = delimiter < 0 ? remaining : remaining.subarray(0, delimiter);
      if (this._frame.length + fragment.length > this._maxInboundFrameBytes) {
        this._protocolFail(`inbound frame exceeds ${this._maxInboundFrameBytes}-byte limit`);
        return;
      }
      if (fragment.length > 0) this._frame = Buffer.concat([this._frame, fragment]);
      if (delimiter < 0) return;

      const frame = this._frame;
      this._frame = Buffer.alloc(0);
      remaining = remaining.subarray(delimiter + 1);
      if (frame.length === 0) {
        if (remaining.length === 0) return;
        continue;
      }
      let message;
      try {
        message = JSON.parse(frame.toString("utf8"));
      } catch (error) {
        this._protocolFail("invalid JSON frame", error);
        return;
      }
      this._accept(message);
      if (remaining.length === 0) return;
    }
  }

  _accept(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this._protocolFail("message must be an object");
      return;
    }
    const hasId = hasOwn(message, "id");
    const hasMethod = hasOwn(message, "method");
    const hasResult = hasOwn(message, "result");
    const hasError = hasOwn(message, "error");
    if (hasMethod) {
      if (hasId || typeof message.method !== "string" || message.method.length === 0 || hasResult || hasError) {
        this._protocolFail("invalid event envelope");
        return;
      }
      const snapshot = structuredClone(message);
      this.notifications.push(snapshot);
      this.emit("notification", snapshot);
      return;
    }
    if (!Number.isSafeInteger(message.id) || message.id <= 0 || hasResult === hasError) {
      this._protocolFail("invalid response envelope");
      return;
    }
    if (hasError && (!message.error || typeof message.error !== "object" || Array.isArray(message.error))) {
      this._protocolFail("invalid RPC error");
      return;
    }
    const pending = this._pending.get(message.id);
    if (!pending) {
      this.emit("orphanResponse", structuredClone(message));
      return;
    }
    this._pending.delete(message.id);
    clearTimeout(pending.timer);
    if (hasError) {
      const rpc = structuredClone(message.error);
      const error = new Error(typeof rpc.message === "string" ? rpc.message : `CDP request ${pending.method} failed`);
      error.rpc = rpc;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  _protocolFail(message, cause) {
    const error = protocolError(message, cause);
    if (!this._terminalError) this.emit("protocolError", error);
    this._fail(error);
  }

  _fail(error) {
    if (this._terminalError) return;
    this._terminalError = asError(error, "CDP pipe failed");
    for (const active of [...this._activeWrites]) active.settle(this._terminalError);
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this._terminalError);
    }
    this._pending.clear();
  }
}
