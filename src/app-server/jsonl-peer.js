import { EventEmitter } from "node:events";

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const initializedPeers = new WeakSet();
const DEFAULT_MAX_INBOUND_RECORD_BYTES = 1024 * 1024;

function asError(value, fallback) {
  if (value instanceof Error) return value;
  return new Error(typeof value?.message === "string" ? value.message : fallback);
}

function protocolError(message, cause) {
  const error = new Error(`JSONL protocol error: ${message}`, cause ? { cause } : undefined);
  error.code = "EPROTOCOL";
  return error;
}

function validId(id) {
  return (typeof id === "number" && Number.isFinite(id)) || (typeof id === "string" && id.length > 0);
}

export class JsonlPeer extends EventEmitter {
  constructor(input, output, { maxInboundRecordBytes = DEFAULT_MAX_INBOUND_RECORD_BYTES } = {}) {
    super();
    if (!input?.on || !output?.on || typeof output.write !== "function") {
      throw new TypeError("input and output must be Node streams");
    }
    if (!Number.isInteger(maxInboundRecordBytes) || maxInboundRecordBytes <= 0) {
      throw new TypeError("maxInboundRecordBytes must be a positive integer");
    }
    this.input = input;
    this.output = output;
    this.outbound = [];
    this.notifications = [];
    this.serverRequests = [];
    this._pending = new Map();
    this._nextId = 1;
    this._recordChunks = [];
    this._recordBytes = 0;
    this._maxInboundRecordBytes = maxInboundRecordBytes;
    this._terminalError = null;
    this._writeTail = Promise.resolve();
    this._activeWrites = new Set();

    input.setEncoding?.("utf8");
    input.on("data", (chunk) => this._onData(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    input.on("error", (error) => this._fail(asError(error, "App Server input failed")));
    input.on("end", () => this._fail(new Error("App Server input closed")));
    input.on("close", () => this._fail(new Error("App Server input closed")));
    output.on("error", (error) => this._fail(asError(error, "App Server output failed")));
    output.on("close", () => this._fail(new Error("App Server output closed")));
  }

  get pendingCount() {
    return this._pending.size;
  }

  get activeWriteCount() {
    return this._activeWrites.size;
  }

  request(method, params = {}, timeoutMs = 15_000) {
    this._assertMethod(method);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
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
      this._pending.delete(id);
      pending.reject(Object.assign(new Error(`App Server request ${method} timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    this._pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer, method });

    this._send({ id, method, params }, () => this._pending.has(id)).catch((error) => this._fail(error));
    return result;
  }

  notify(method, params = {}) {
    this._assertMethod(method);
    return this._send({ method, params });
  }

  respond(id, result) {
    if (!validId(id)) return Promise.reject(new TypeError("response id must be a finite number or nonempty string"));
    return this._send({ id, result });
  }

  _assertMethod(method) {
    if (typeof method !== "string" || method.length === 0) throw new TypeError("method must be a nonempty string");
  }

  _send(message, shouldSend = () => true) {
    if (this._terminalError) return Promise.reject(this._terminalError);
    let line;
    let snapshot;
    try {
      const serialized = JSON.stringify(message);
      line = `${serialized}\n`;
      snapshot = JSON.parse(serialized);
    } catch (error) {
      return Promise.reject(error);
    }
    const write = () => new Promise((resolve, reject) => {
      if (!shouldSend()) {
        resolve();
        return;
      }
      if (this._terminalError) {
        reject(this._terminalError);
        return;
      }
      if (this.output.destroyed || this.output.writableEnded) {
        reject(new Error("App Server output is closed"));
        return;
      }
      let settled = false;
      const activeWrite = {
        settle: (error) => {
          if (settled) return;
          settled = true;
          this._activeWrites.delete(activeWrite);
          if (error) reject(asError(error, "App Server output write failed"));
          else resolve();
        },
      };
      this._activeWrites.add(activeWrite);
      try {
        this.outbound.push(snapshot);
        this.output.write(line, "utf8", activeWrite.settle);
      } catch (error) {
        activeWrite.settle(error);
      }
    });
    const current = this._writeTail.then(write);
    this._writeTail = current.catch(() => {});
    current.catch((error) => this._fail(error));
    return current;
  }

  _onData(chunk) {
    if (this._terminalError) return;
    let start = 0;
    while (!this._terminalError) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      if (!this._appendRecordChunk(chunk, start, end)) return;
      if (newline < 0) return;

      let line = this._recordChunks.join("");
      this._recordChunks = [];
      this._recordBytes = 0;
      start = newline + 1;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this._protocolFail("invalid JSON line", error);
        return;
      }
      this._accept(message);
    }
  }

  _appendRecordChunk(chunk, start, end) {
    if (this._recordBytes + (end - start) > this._maxInboundRecordBytes) {
      this._protocolFail(`inbound record exceeds ${this._maxInboundRecordBytes}-byte limit`);
      return false;
    }
    if (end === start) return true;
    const fragment = chunk.slice(start, end);
    const bytes = Buffer.byteLength(fragment, "utf8");
    if (this._recordBytes + bytes > this._maxInboundRecordBytes) {
      this._protocolFail(`inbound record exceeds ${this._maxInboundRecordBytes}-byte limit`);
      return false;
    }
    this._recordChunks.push(fragment);
    this._recordBytes += bytes;
    return true;
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
      if (typeof message.method !== "string" || message.method.length === 0 || hasResult || hasError || (hasId && !validId(message.id))) {
        this._protocolFail("invalid request or notification");
        return;
      }
      const snapshot = structuredClone(message);
      if (hasId) {
        this.serverRequests.push(snapshot);
        this.emit("serverRequest", snapshot);
      } else {
        this.notifications.push(snapshot);
        this.emit("notification", snapshot);
      }
      return;
    }

    if (!hasId || !validId(message.id) || hasResult === hasError) {
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
      const error = new Error(typeof rpc.message === "string" ? rpc.message : `App Server request ${pending.method} failed`);
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
    this._terminalError = asError(error, "App Server peer failed");
    for (const activeWrite of [...this._activeWrites]) activeWrite.settle(this._terminalError);
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this._terminalError);
    }
    this._pending.clear();
  }
}

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: "codex_projectboard_phase0",
  title: "Codex Projectboard Phase 0",
  version: "0.1.0",
});

function validateClientInfo(clientInfo) {
  const valid = clientInfo
    && typeof clientInfo === "object"
    && !Array.isArray(clientInfo)
    && ["name", "title", "version"].every((key) => typeof clientInfo[key] === "string" && clientInfo[key].length > 0);
  if (!valid) throw new TypeError("clientInfo must contain nonempty name, title, and version strings");
  return Object.freeze({ name: clientInfo.name, title: clientInfo.title, version: clientInfo.version });
}

export async function initializeStable(peer, clientInfo = DEFAULT_CLIENT_INFO) {
  if (!peer || (typeof peer !== "object" && typeof peer !== "function")) throw new TypeError("peer is required");
  if (initializedPeers.has(peer)) throw new Error("App Server peer initialization already attempted");
  const validatedClientInfo = validateClientInfo(clientInfo);
  initializedPeers.add(peer);
  const response = await peer.request("initialize", {
    clientInfo: validatedClientInfo,
  });
  await peer.notify("initialized", {});
  return response;
}
