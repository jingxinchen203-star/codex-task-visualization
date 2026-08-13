const FRAME_ID = "projectboard-phase0-frame";
const TOGGLE_ID = "projectboard-phase1-toggle";
const ACTIONS = new Set(["mount", "update", "stale", "take-move", "count", "remove"]);
const LAYOUTS = new Set(["probe", "sidebar"]);
const STATIC_BOARD_MARKER = /<html\b[^>]*\bdata-projectboard-static=(?:"true"|'true')/iu;
const SCRIPT_ELEMENT = /<script\b/iu;
const CANONICAL_LANES = Object.freeze(["inbox", "planned", "running", "review", "done"]);

function targetIdentity(target) {
  if (typeof target?.targetId === "string" && target.targetId.length > 0) return target.targetId;
  if (typeof target?.id === "string" && target.id.length > 0) return target.id;
  return null;
}

function snapshotReceipt(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || typeof snapshot.snapshotId !== "string"
    || !/^[0-9a-f]{64}$/u.test(snapshot.snapshotId)
    || !Number.isSafeInteger(snapshot.summary?.taskCount)
    || snapshot.summary.taskCount < 0) {
    throw new TypeError("a snapshot with a valid receipt identity is required");
  }
  return { snapshotId: snapshot.snapshotId, taskCount: snapshot.summary.taskCount };
}

export function selectCodexTargets(targetInfos) {
  if (!Array.isArray(targetInfos)) throw new TypeError("targetInfos must be an array");
  const appPages = targetInfos.filter(
    (target) => target?.type === "page" && typeof target.url === "string" && /^app:\/\//iu.test(target.url),
  );
  if (appPages.length === 0) throw new Error("No Codex app page targets were discovered");

  const selected = appPages.map((target) => {
    const targetId = targetIdentity(target);
    if (!targetId) throw new Error("Each Codex app page target must have a nonempty targetId or id");
    return { ...target, targetId };
  });
  selected.sort((left, right) => left.targetId.localeCompare(right.targetId, "en"));
  return selected;
}

function mountExpression({ url = null, html = null }, timeoutMs, layout, receipt, staticBoard) {
  return `/*projectboard-phase0:mount*/
(() => {
  const frameId = ${JSON.stringify(FRAME_ID)};
  const sourceUrl = ${JSON.stringify(url)};
  const sourceHtml = ${JSON.stringify(html)};
  const timeoutMs = ${timeoutMs};
  const deadline = Date.now() + timeoutMs;
  const layout = ${JSON.stringify(layout)};
  const expectedSnapshotId = ${JSON.stringify(receipt?.snapshotId ?? null)};
  const expectedTaskCount = ${JSON.stringify(receipt?.taskCount ?? null)};
  const staticBoard = ${JSON.stringify(staticBoard)};
  const canonicalLanes = ${JSON.stringify(CANONICAL_LANES)};
  const toggleId = ${JSON.stringify(TOGGLE_ID)};
  const countFrames = () => document.querySelectorAll("#" + frameId).length;
  let frame = document.getElementById(frameId);
  let created = false;
  if (frame && frame.tagName !== "IFRAME") {
    return Promise.resolve({ status: "error", count: countFrames(), error: "reserved id is not an iframe" });
  }
  if (!frame) {
    frame = document.createElement("iframe");
    frame.id = frameId;
    frame.setAttribute("data-projectboard-phase0", "true");
    created = true;
  }
  frame.setAttribute("sandbox", staticBoard ? "allow-same-origin" : "allow-scripts");
  const applySidebarLayout = (host) => {
    if (layout !== "sidebar") return;
    frame.title = "Codex 五栏任务看板（只读）";
    frame.style.position = "fixed";
    const positionFrame = () => {
      const main = document.querySelector("main");
      const rect = main?.getBoundingClientRect?.();
      const hasMainRegion = rect && rect.width > 240 && rect.height > 240;
      const viewportWidth = document.documentElement?.clientWidth || globalThis.innerWidth || 0;
      const viewportHeight = document.documentElement?.clientHeight || globalThis.innerHeight || 0;
      const left = hasMainRegion ? Math.max(0, Math.round(rect.left)) : 0;
      const top = hasMainRegion ? Math.max(0, Math.round(rect.top)) : 48;
      const width = hasMainRegion ? Math.round(rect.width) : Math.max(0, viewportWidth - left);
      const height = hasMainRegion ? Math.round(rect.height) : Math.max(0, viewportHeight - top);
      frame.style.left = left + "px";
      frame.style.top = top + "px";
      frame.style.right = "auto";
      frame.style.bottom = "auto";
      frame.style.width = Math.max(0, width) + "px";
      frame.style.height = Math.max(0, height) + "px";
    };
    positionFrame();
    if (frame.__projectboardPositionFrame !== positionFrame) {
      if (typeof frame.__projectboardPositionFrame === "function") {
        globalThis.removeEventListener?.("resize", frame.__projectboardPositionFrame);
      }
      frame.__projectboardPositionFrame = positionFrame;
      globalThis.addEventListener?.("resize", positionFrame);
    }
    frame.style.border = "0";
    frame.style.borderLeft = "1px solid rgba(127, 127, 127, 0.24)";
    frame.style.background = "#171716";
    frame.style.boxShadow = "-10px 0 28px rgba(0, 0, 0, 0.18)";
    frame.style.zIndex = "2147483645";
    frame.style.colorScheme = "light dark";
    frame.style.webkitAppRegion = "no-drag";
    let toggle = document.getElementById(toggleId);
    if (!toggle) {
      toggle = document.createElement("button");
      toggle.id = toggleId;
      toggle.type = "button";
      toggle.setAttribute("aria-controls", frameId);
      toggle.setAttribute("aria-expanded", "true");
      toggle.title = "收起只读任务看板";
      toggle.textContent = "›";
      toggle.style.position = "fixed";
      toggle.style.top = "50%";
      toggle.style.right = "0";
      toggle.style.transform = "translateY(-50%)";
      toggle.style.width = "26px";
      toggle.style.height = "52px";
      toggle.style.padding = "0";
      toggle.style.border = "1px solid rgba(127, 127, 127, 0.34)";
      toggle.style.borderRight = "0";
      toggle.style.borderRadius = "8px 0 0 8px";
      toggle.style.background = "rgba(35, 35, 33, 0.96)";
      toggle.style.color = "#f5f5f4";
      toggle.style.font = "24px/1 system-ui";
      toggle.style.cursor = "pointer";
      toggle.style.zIndex = "2147483646";
      toggle.style.webkitAppRegion = "no-drag";
      host.appendChild(toggle);
    }
    const reflectToggle = () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.title = expanded ? "收起只读任务看板" : "展开只读任务看板";
      toggle.textContent = expanded ? "›" : "‹";
      frame.hidden = !expanded;
    };
    toggle.onclick = () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      reflectToggle();
    };
    reflectToggle();
  };
  const waitForHost = () => new Promise((resolve) => {
    const check = () => {
      const host = document.body || document.documentElement;
      if (host) {
        resolve(host);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(check, 16);
    };
    check();
  });
  return waitForHost().then((host) => {
    if (!host) return { status: "timeout", count: countFrames(), error: "document host was unavailable" };
    applySidebarLayout(host);
    const receiptMatches = expectedSnapshotId !== null
      && frame.getAttribute("data-projectboard-snapshot-id") === expectedSnapshotId
      && frame.getAttribute("data-projectboard-rendered-task-count") === String(expectedTaskCount);
    if (frame.getAttribute("data-projectboard-loaded") === "true"
      && (expectedSnapshotId === null || receiptMatches)) {
      return {
        status: "loaded",
        count: countFrames(),
        ...(receiptMatches ? {
          snapshotId: expectedSnapshotId,
          renderedTaskCount: expectedTaskCount,
        } : {}),
      };
    }
    if (expectedSnapshotId !== null) frame.setAttribute("data-projectboard-loaded", "false");
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (status, error, acknowledged = false) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        frame.removeEventListener("load", onLoad);
        frame.removeEventListener("error", onError);
        globalThis.removeEventListener?.("message", onMessage);
        if (status === "loaded") {
          frame.setAttribute("data-projectboard-loaded", "true");
          if (acknowledged) {
            frame.setAttribute("data-projectboard-snapshot-id", expectedSnapshotId);
            frame.setAttribute("data-projectboard-rendered-task-count", String(expectedTaskCount));
          }
        }
        resolve({
          status,
          count: countFrames(),
          ...(acknowledged ? {
            snapshotId: expectedSnapshotId,
            renderedTaskCount: expectedTaskCount,
          } : {}),
          ...(error ? { error } : {}),
        });
      };
      const onLoad = () => {
        if (expectedSnapshotId === null) {
          finish("loaded");
          return;
        }
        if (!staticBoard) return;
        try {
          const childDocument = frame.contentDocument;
          const root = childDocument?.documentElement;
          const tasks = [...(childDocument?.querySelectorAll?.("[data-projectboard-task-id]") ?? [])];
          const taskIds = tasks.map((task) => task.getAttribute("data-projectboard-task-id"));
          const lanes = [...(childDocument?.querySelectorAll?.("[data-projectboard-lane]") ?? [])]
            .map((lane) => lane.getAttribute("data-projectboard-lane"));
          const acknowledged = root?.getAttribute("data-projectboard-static") === "true"
            && root.getAttribute("data-projectboard-mode") === "standalone-readonly"
            && root.getAttribute("data-projectboard-snapshot-id") === expectedSnapshotId
            && root.getAttribute("data-projectboard-rendered-task-count") === String(expectedTaskCount)
            && taskIds.length === expectedTaskCount
            && taskIds.every((id) => typeof id === "string" && id.length > 0)
            && new Set(taskIds).size === expectedTaskCount
            && lanes.length === canonicalLanes.length
            && new Set(lanes).size === canonicalLanes.length
            && canonicalLanes.every((id) => lanes.includes(id));
          finish(
            acknowledged ? "loaded" : "error",
            acknowledged ? null : "static board did not contain the expected snapshot exactly once",
            acknowledged,
          );
        } catch {
          finish("error", "static board validation failed");
        }
      };
      const onError = () => finish("error", "iframe failed to load");
      const onMessage = (event) => {
        const data = event?.data;
        if (expectedSnapshotId === null
          || event?.source !== frame.contentWindow
          || data?.type !== "projectboard-readonly-ready"
          || data.snapshotId !== expectedSnapshotId
          || data.sourceTaskCount !== expectedTaskCount
          || data.renderedTaskCount !== expectedTaskCount) return;
        finish("loaded", null, true);
      };
      frame.addEventListener("load", onLoad, { once: true });
      frame.addEventListener("error", onError, { once: true });
      if (!staticBoard) globalThis.addEventListener?.("message", onMessage);
      timer = setTimeout(
        () => finish("timeout", expectedSnapshotId === null
          ? "iframe load timed out"
          : "iframe renderer acknowledgement timed out"),
        Math.max(1, deadline - Date.now()),
      );
      if (created || expectedSnapshotId !== null) {
        if (sourceHtml !== null) {
          const blobUrl = URL.createObjectURL(new Blob([sourceHtml], { type: "text/html;charset=utf-8" }));
          frame.setAttribute("data-projectboard-blob-url", blobUrl);
          frame.src = blobUrl;
        } else {
          frame.src = sourceUrl;
        }
        if (created) host.appendChild(frame);
      }
    });
  });
})()`;
}

function countExpression() {
  return `/*projectboard-phase0:count*/
(() => ({ status: "count", count: document.querySelectorAll(${JSON.stringify(`#${FRAME_ID}`)}).length }))()`;
}

function updateExpression(snapshot, updateId, timeoutMs, receipt) {
  return `/*projectboard-phase1:update*/
(() => {
  const frame = document.getElementById(${JSON.stringify(FRAME_ID)});
  if (!frame || frame.tagName !== "IFRAME" || !frame.contentWindow) {
    return Promise.resolve({ status: "missing", updated: false });
  }
  const updateId = ${JSON.stringify(updateId)};
  const expectedSnapshotId = ${JSON.stringify(receipt.snapshotId)};
  const expectedTaskCount = ${JSON.stringify(receipt.taskCount)};
  const timeoutMs = ${JSON.stringify(timeoutMs)};
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      globalThis.removeEventListener?.("message", onMessage);
      resolve(result);
    };
    const onMessage = (event) => {
      const data = event?.data;
      if (event?.source !== frame.contentWindow
        || data?.type !== "projectboard-readonly-applied"
        || data.updateId !== updateId
        || data.snapshotId !== expectedSnapshotId
        || data.sourceTaskCount !== expectedTaskCount
        || data.renderedTaskCount !== expectedTaskCount) return;
      frame.setAttribute("data-projectboard-loaded", "true");
      frame.setAttribute("data-projectboard-snapshot-id", expectedSnapshotId);
      frame.setAttribute("data-projectboard-rendered-task-count", String(expectedTaskCount));
      finish({ status: "updated", updated: true });
    };
    globalThis.addEventListener?.("message", onMessage);
    timer = setTimeout(() => finish({
      status: "timeout",
      updated: false,
      error: "sidebar update acknowledgement timed out",
    }), timeoutMs);
    try {
      frame.contentWindow.postMessage({
        type: "projectboard-readonly-snapshot",
        updateId,
        snapshot: ${JSON.stringify(snapshot)},
      }, "*");
    } catch {
      finish({
        status: "error",
        updated: false,
        error: "sidebar update postMessage failed",
      });
    }
  });
})()`;
}

function staticUpdateExpression(html, snapshot, timeoutMs, receipt) {
  const finalizedMount = mountExpression(
    { html },
    timeoutMs,
    "sidebar",
    receipt,
    true,
  );
  return `/*projectboard-phase1:update*/
(() => {
  const frameId = ${JSON.stringify(FRAME_ID)};
  const candidateId = frameId + "-candidate";
  const expectedSnapshotId = ${JSON.stringify(receipt.snapshotId)};
  const expectedTaskCount = ${JSON.stringify(receipt.taskCount)};
  const canonicalLanes = ${JSON.stringify(CANONICAL_LANES)};
  const frame = document.getElementById(frameId);
  if (!frame || frame.tagName !== "IFRAME") {
    return Promise.resolve({ status: "missing", updated: false });
  }
  if (frame.getAttribute("data-projectboard-loaded") === "true"
    && frame.getAttribute("data-projectboard-snapshot-id") === expectedSnapshotId
    && frame.getAttribute("data-projectboard-rendered-task-count") === String(expectedTaskCount)) {
    return Promise.resolve({ status: "updated", updated: true });
  }
  const host = frame.parentNode || document.body || document.documentElement;
  if (!host) return Promise.resolve({ status: "error", updated: false, error: "document host was unavailable" });
  const previousCandidate = document.getElementById(candidateId);
  if (previousCandidate) {
    const previousUrl = previousCandidate.getAttribute("data-projectboard-blob-url");
    previousCandidate.remove();
    if (typeof previousUrl === "string" && previousUrl.startsWith("blob:")) URL.revokeObjectURL(previousUrl);
  }
  const candidate = document.createElement("iframe");
  candidate.id = candidateId;
  candidate.title = frame.title;
  candidate.setAttribute("sandbox", "allow-same-origin");
  candidate.setAttribute("data-projectboard-phase0", "true");
  candidate.style.position = "fixed";
  candidate.style.width = "1px";
  candidate.style.height = "1px";
  candidate.style.visibility = "hidden";
  candidate.style.pointerEvents = "none";
  const blobUrl = URL.createObjectURL(new Blob([${JSON.stringify(html)}], { type: "text/html;charset=utf-8" }));
  candidate.setAttribute("data-projectboard-blob-url", blobUrl);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      candidate.removeEventListener("load", onLoad);
      candidate.removeEventListener("error", onError);
    };
    const rejectCandidate = (status, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      candidate.remove();
      URL.revokeObjectURL(blobUrl);
      resolve({ status, updated: false, error });
    };
    const onError = () => rejectCandidate("error", "static board candidate failed to load");
    const onLoad = () => {
      if (settled) return;
      try {
        const childDocument = candidate.contentDocument;
        const root = childDocument?.documentElement;
        const tasks = [...(childDocument?.querySelectorAll?.("[data-projectboard-task-id]") ?? [])];
        const taskIds = tasks.map((task) => task.getAttribute("data-projectboard-task-id"));
        const lanes = [...(childDocument?.querySelectorAll?.("[data-projectboard-lane]") ?? [])]
          .map((lane) => lane.getAttribute("data-projectboard-lane"));
        const acknowledged = root?.getAttribute("data-projectboard-static") === "true"
          && root.getAttribute("data-projectboard-mode") === "standalone-readonly"
          && root.getAttribute("data-projectboard-snapshot-id") === expectedSnapshotId
          && root.getAttribute("data-projectboard-rendered-task-count") === String(expectedTaskCount)
          && taskIds.length === expectedTaskCount
          && taskIds.every((id) => typeof id === "string" && id.length > 0)
          && new Set(taskIds).size === expectedTaskCount
          && lanes.length === canonicalLanes.length
          && new Set(lanes).size === canonicalLanes.length
          && canonicalLanes.every((id) => lanes.includes(id));
        if (!acknowledged) {
          rejectCandidate("error", "static board candidate did not contain the expected snapshot exactly once");
          return;
        }
        settled = true;
        cleanup();
        const previousBlobUrl = frame.getAttribute("data-projectboard-blob-url");
        if (typeof frame.__projectboardPositionFrame === "function") {
          globalThis.removeEventListener?.("resize", frame.__projectboardPositionFrame);
        }
        if (typeof frame.style?.cssText === "string") candidate.style.cssText = frame.style.cssText;
        candidate.style.visibility = "";
        candidate.style.pointerEvents = "";
        candidate.hidden = frame.hidden;
        candidate.id = frameId;
        candidate.setAttribute("data-projectboard-loaded", "true");
        candidate.setAttribute("data-projectboard-snapshot-id", expectedSnapshotId);
        candidate.setAttribute("data-projectboard-rendered-task-count", String(expectedTaskCount));
        frame.replaceWith(candidate);
        if (typeof previousBlobUrl === "string" && previousBlobUrl.startsWith("blob:")
          && previousBlobUrl !== blobUrl) URL.revokeObjectURL(previousBlobUrl);
        Promise.resolve(${finalizedMount}).then((result) => {
          resolve(result?.status === "loaded"
            && result.snapshotId === expectedSnapshotId
            && result.renderedTaskCount === expectedTaskCount
            ? { status: "updated", updated: true }
            : { ...result, updated: false });
        }, () => resolve({ status: "error", updated: false, error: "static board candidate finalization failed" }));
      } catch {
        rejectCandidate("error", "static board candidate validation failed");
      }
    };
    candidate.addEventListener("load", onLoad, { once: true });
    candidate.addEventListener("error", onError, { once: true });
    timer = setTimeout(() => rejectCandidate("timeout", "static board candidate acknowledgement timed out"), ${JSON.stringify(timeoutMs)});
    candidate.src = blobUrl;
    host.appendChild(candidate);
  });
})()`;
}

function staleExpression(snapshotId) {
  return `/*projectboard-phase1:stale*/
(() => {
  const frame = document.getElementById(${JSON.stringify(FRAME_ID)});
  if (!frame || frame.tagName !== "IFRAME" || !frame.contentWindow) {
    return { status: "missing", posted: false };
  }
  const staticRoot = frame.contentDocument?.documentElement;
  if (staticRoot?.getAttribute("data-projectboard-static") === "true") {
    const snapshotId = ${JSON.stringify(snapshotId)};
    if (staticRoot.getAttribute("data-projectboard-snapshot-id") !== snapshotId) {
      return { status: "stale", posted: false };
    }
    staticRoot.setAttribute("data-projectboard-stale", "true");
    const status = frame.contentDocument?.querySelector?.("#sync-status");
    if (status) status.textContent = "数据已过期 · 保留最后一次确认的只读快照";
    return { status: "stale", posted: true };
  }
  frame.contentWindow.postMessage({
    type: "projectboard-readonly-stale",
    snapshotId: ${JSON.stringify(snapshotId)},
  }, "*");
  return { status: "stale", posted: true };
})()`;
}

function takeMoveExpression(snapshotId) {
  return `/*projectboard-phase1:take-move*/
(() => {
  const frame = document.getElementById(${JSON.stringify(FRAME_ID)});
  if (!frame || frame.tagName !== "IFRAME" || !frame.contentWindow) {
    return { status: "missing" };
  }
  const childDocument = frame.contentDocument;
  const root = childDocument?.documentElement;
  const expectedSnapshotId = ${JSON.stringify(snapshotId)};
  if (root?.getAttribute("data-projectboard-static") !== "true"
    || root.getAttribute("data-projectboard-snapshot-id") !== expectedSnapshotId) {
    return { status: "stale" };
  }
  const canonicalLanes = ${JSON.stringify(CANONICAL_LANES)};
  const cards = [...(childDocument?.querySelectorAll?.("[data-projectboard-thread-id]") ?? [])];
  const validatedMove = (threadId, laneId) => {
    const matches = cards.filter((card) => card.getAttribute("data-projectboard-thread-id") === threadId);
    const valid = typeof threadId === "string"
      && threadId.length > 0
      && threadId.length <= 512
      && !/[\\0-\\x1f\\x7f]/u.test(threadId)
      && canonicalLanes.includes(laneId)
      && matches.length === 1;
    if (!valid) return { status: "invalid" };
    return {
      status: "move",
      snapshotId: expectedSnapshotId,
      threadId,
      laneId,
      currentLaneId: matches[0].getAttribute("data-projectboard-current-lane"),
    };
  };
  const pendingMoves = [...(childDocument?.querySelectorAll?.("[data-projectboard-move-thread][data-projectboard-move-lane]:checked") ?? [])];
  if (pendingMoves.length > 0) {
    const request = pendingMoves[0];
    request.checked = false;
    if (pendingMoves.length !== 1) return { status: "invalid" };
    return validatedMove(
      request.getAttribute("data-projectboard-move-thread"),
      request.getAttribute("data-projectboard-move-lane"),
    );
  }
  const hash = frame.contentWindow.location?.hash ?? "";
  const clearRequest = () => {
    try {
      const location = frame.contentWindow.location;
      frame.contentWindow.history.replaceState(null, "", location.href.split("#", 1)[0]);
    } catch {
      try { frame.contentWindow.location.hash = ""; } catch {}
    }
  };
  const openPrefix = "#projectboard-open/";
  if (hash.startsWith(openPrefix)) {
    clearRequest();
    let threadId;
    try { threadId = decodeURIComponent(hash.slice(openPrefix.length)); } catch {
      return { status: "invalid" };
    }
    const validated = validatedMove(threadId, "inbox");
    return validated.status === "move"
      ? { status: "open", snapshotId: expectedSnapshotId, threadId }
      : validated;
  }
  return { status: "idle" };
})()`;
}

function removeExpression() {
  return `/*projectboard-phase0:remove*/
(() => {
  const frames = [...document.querySelectorAll(${JSON.stringify(`#${FRAME_ID}`)})];
  let revoked = 0;
  for (const frame of frames) {
    if (typeof frame.__projectboardPositionFrame === "function") {
      globalThis.removeEventListener?.("resize", frame.__projectboardPositionFrame);
    }
    const blobUrl = frame.getAttribute("data-projectboard-blob-url");
    frame.remove();
    if (typeof blobUrl === "string" && blobUrl.startsWith("blob:")) {
      URL.revokeObjectURL(blobUrl);
      revoked += 1;
    }
  }
  document.getElementById(${JSON.stringify(TOGGLE_ID)})?.remove();
  return { status: "removed", removed: frames.length, revoked };
})()`;
}

export function buildFrameExpression(action, {
  url,
  html,
  snapshot,
  updateId,
  timeoutMs = 2_000,
  layout = "probe",
} = {}) {
  if (!ACTIONS.has(action)) throw new TypeError(`Unsupported frame action: ${String(action)}`);
  if (action === "mount") {
    const hasUrl = typeof url === "string" && url.length > 0;
    const hasHtml = typeof html === "string" && html.length > 0;
    if (Number(hasUrl) + Number(hasHtml) !== 1) {
      throw new TypeError("mount requires exactly one nonempty url or html source");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
    if (!LAYOUTS.has(layout)) throw new TypeError("layout must be probe or sidebar");
    const receipt = snapshot === undefined ? null : snapshotReceipt(snapshot);
    const staticBoard = hasHtml
      && receipt !== null
      && STATIC_BOARD_MARKER.test(html)
      && !SCRIPT_ELEMENT.test(html);
    return mountExpression(
      { url: hasUrl ? url : null, html: hasHtml ? html : null },
      timeoutMs,
      layout,
      receipt,
      staticBoard,
    );
  }
  if (action === "update") {
    const receipt = snapshotReceipt(snapshot);
    if (typeof updateId !== "string" || updateId.length === 0) {
      throw new TypeError("updateId must be a nonempty string");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
    if (html !== undefined) {
      if (typeof html !== "string" || html.length === 0
        || !STATIC_BOARD_MARKER.test(html)
        || SCRIPT_ELEMENT.test(html)) {
        throw new TypeError("static update html must be a nonempty scriptless static board document");
      }
      return staticUpdateExpression(html, snapshot, timeoutMs, receipt);
    }
    return updateExpression(snapshot, updateId, timeoutMs, receipt);
  }
  if (action === "stale") return staleExpression(snapshotReceipt(snapshot).snapshotId);
  if (action === "take-move") return takeMoveExpression(snapshotReceipt(snapshot).snapshotId);
  return action === "count" ? countExpression() : removeExpression();
}

export function readEvaluationValue(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new TypeError("Runtime.evaluate response must be an object");
  }
  return {
    value: response.result?.value,
    exceptionDetails: response.exceptionDetails ?? null,
  };
}
