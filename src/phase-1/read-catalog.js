import { initializeStable } from "../app-server/jsonl-peer.js";
import {
  DESKTOP_HOST_APP_SERVER_ARGUMENTS,
  listAllThreadMetadata,
  openAppServer,
} from "../app-server/probe-readonly.js";

const READ_ONLY_METHODS = new Set(["initialize", "initialized", "account/read", "thread/list"]);
const CLIENT_INFO = Object.freeze({
  name: "codex_projectboard_phase1_readonly",
  title: "Codex Projectboard Phase 1 (Read Only)",
  version: "0.2.0",
});

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateAccount(account) {
  if (!account || typeof account !== "object" || Array.isArray(account) || typeof account.requiresOpenaiAuth !== "boolean") {
    throw codedError("EACCOUNTSHAPE", "account/read returned a malformed response");
  }
  if (account.account !== null && account.account !== undefined
    && (!account.account || typeof account.account !== "object" || typeof account.account.type !== "string")) {
    throw codedError("EACCOUNTSHAPE", "account/read returned a malformed account identity");
  }
}

function validateClose(outcome) {
  const healthy = outcome?.settlement?.unsettled === false
    && outcome.settlement.code === 0
    && outcome.settlement.signal === null
    && outcome.settlement.error === null
    && outcome?.disposal?.cleanup?.ok === true
    && !outcome?.disposal?.cleanup?.error
    && !outcome?.stderr?.error;
  if (!healthy) throw codedError("EAPPSERVERLIFECYCLE", "Read-only App Server did not close cleanly");
}

function outboundMethods(peer) {
  if (!Array.isArray(peer?.outbound)) throw codedError("EREADONLYMETHOD", "App Server outbound evidence is unavailable");
  const methods = peer.outbound.map(({ method }) => method).filter((method) => typeof method === "string");
  if (methods.some((method) => !READ_ONLY_METHODS.has(method))) {
    throw codedError("EREADONLYMETHOD", "App Server session attempted a method outside the read-only allowlist");
  }
  return methods;
}

export async function readReadonlyThreadCatalog(candidate, sourceKinds, {
  open = openAppServer,
  initialize = initializeStable,
  list = listAllThreadMetadata,
} = {}) {
  const handle = await open(candidate, { appServerArguments: DESKTOP_HOST_APP_SERVER_ARGUMENTS });
  let result = null;
  let primaryError = null;
  try {
    await initialize(handle.peer, CLIENT_INFO);
    const account = await handle.peer.request("account/read", { refreshToken: false });
    validateAccount(account);
    const activeThreads = await list(handle.peer, false, sourceKinds);
    const archivedThreads = await list(handle.peer, true, sourceKinds);
    const methods = outboundMethods(handle.peer);
    result = Object.freeze({
      accountType: account.account?.type ?? null,
      requiresOpenaiAuth: account.requiresOpenaiAuth,
      activeThreads: Object.freeze([...activeThreads]),
      archivedThreads: Object.freeze([...archivedThreads]),
      outboundMethods: Object.freeze(methods),
    });
  } catch (error) {
    primaryError = error;
  }

  let closeError = null;
  try {
    validateClose(await handle.close());
  } catch (error) {
    closeError = error?.code === "EAPPSERVERLIFECYCLE"
      ? error
      : Object.assign(codedError("EAPPSERVERLIFECYCLE", "Read-only App Server close failed"), { cause: error });
  }
  try {
    outboundMethods(handle.peer);
  } catch (error) {
    primaryError = error;
  }
  if (primaryError) {
    if (closeError) primaryError.closeError = closeError;
    throw primaryError;
  }
  if (closeError) throw closeError;
  return result;
}
