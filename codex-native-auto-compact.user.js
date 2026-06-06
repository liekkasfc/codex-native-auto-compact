// ==UserScript==
// @name         Codex Native Auto Compact
// @namespace    https://github.com/max/codex-native-auto-compact
// @version      0.3.0
// @description  Automatically compresses Codex conversations when context usage is high.
// @match        *://*/*
// @grant        none
// @license      MIT
// ==/UserScript==

(() => {
  // Auto Compact configuration
  const API_KEY = "__codexNativeAutoCompact";
  const CONFIG_STORAGE_KEY = "codexNativeAutoCompactConfig";
  const DEFAULT_CONFIG = {
    thresholdUsedPercent: 68,
    contextWindowOverride: 73728,
    minRemainingTokensBeforeCompact: 20000,
    pollIntervalMs: 5000,
    cooldownMs: 2 * 60 * 1000,
    menuOpenDelayMs: 650,
    confirmDelayMs: 650,
    onlyWhenIdle: true,
    verifyAfterCompact: true,
    verifyDelayMs: 8000,
    verifyTimeoutMs: 60000,
    verifyPollIntervalMs: 3000,
    verifyMinReductionTokens: 1000,
    dryRun: false,
    debug: false,
  };

  // Context Ring Restore configuration
  const INSTALL_KEY = "__codexContextRingRestoreInstalled";
  const PANEL_VERSION = "context-ring-restore-3";
  const CACHE_TTL_MS = 1500;
  const CAPTURE_TEXT_HINT_RE = /context|token|tokens|usage|window|budget|remaining|compress this conversation|压缩此对话的上下文|上下文|令牌|使用|窗口/i;
  const MAX_CAPTURE_TEXT_LENGTH = 800000;

  // Auto Compact state
  const state = {
    timer: 0,
    destroyed: false,
    running: false,
    lastAttemptByConversationId: new Map(),
    lastAction: null,
    lastSkip: null,
  };

  // Context Ring Restore state
  let cachedContextUsage = { at: 0, value: null };
  const officialMenuUsageByConversationId = new Map();
  const capturedUsageByConversationId = new Map();
  let captureInstalled = false;

  // Prevent double installation
  if (window[INSTALL_KEY]) return;
  window[INSTALL_KEY] = true;

  const COMPRESS_TEXT_RE = /压缩此对话的上下文|压缩上下文|压缩对话|compress this conversation|compact this conversation|compact context|compress context/i;
  const CONFIRM_TEXT_RE = /^(压缩|确认|继续|compress|compact|confirm|continue)$/i;
  const CONTEXT_TEXT_RE = /context|token|tokens|usage|window|budget|remaining|上下文|令牌|使用|窗口|压缩/i;
  const SEND_TEXT_RE = /send|发送|submit|提交/i;

  // ========================
  // Context Ring Restore helpers
  // ========================

  function firstFiniteNumber(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function normalizeConversationId(value) {
    if (value == null) return null;
    if (typeof value !== "string" && typeof value !== "number") return null;
    const text = String(value).trim();
    if (!text) return null;
    const uuidMatch = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text);
    if (uuidMatch) return uuidMatch[0].toLowerCase();
    return text.replace(/^[a-z]+:/i, "").toLowerCase();
  }

  function formatTokenCount(value) {
    return Math.round(value).toLocaleString("en-US");
  }

  function makeUsageReading(percent, usedTokens, contextWindow, exact = true) {
    if (!Number.isFinite(percent)) return null;
    const safePercent = Math.max(0, Math.min(100, Number(percent)));
    const roundedPercent = Math.max(0, Math.min(100, Math.round(safePercent)));
    const hasRatio = Number.isFinite(usedTokens) && Number.isFinite(contextWindow) && contextWindow > 0;
    const normalizedUsedTokens = hasRatio ? Math.min(Number(usedTokens), Number(contextWindow)) : null;
    const normalizedContextWindow = hasRatio ? Number(contextWindow) : null;
    const remainingTokens = hasRatio ? Math.max(normalizedContextWindow - normalizedUsedTokens, 0) : null;

    return {
      exact,
      percent: safePercent,
      usedTokens: normalizedUsedTokens,
      contextWindow: normalizedContextWindow,
      remainingTokens,
      summary: `已使用 ${roundedPercent}%`,
      label: hasRatio
        ? `${formatTokenCount(normalizedUsedTokens)} / ${formatTokenCount(normalizedContextWindow)}`
        : `${roundedPercent}%`,
      detail: hasRatio
        ? `已用 ${formatTokenCount(normalizedUsedTokens)} / ${formatTokenCount(normalizedContextWindow)} tokens（${roundedPercent}%），剩余 ${formatTokenCount(remainingTokens)}。`
        : `已使用 ${roundedPercent}%。`,
    };
  }

  // React fiber graph search
  function getOwnKeyByPrefix(target, prefix) {
    if (!target || (typeof target !== "object" && typeof target !== "function")) return null;
    return Object.keys(target).find((key) => key.startsWith(prefix)) || null;
  }

  function getReactFiber(target) {
    const fiberKey = getOwnKeyByPrefix(target, "__reactFiber$");
    if (fiberKey) return target[fiberKey];
    const containerKey = getOwnKeyByPrefix(target, "__reactContainer$");
    return containerKey ? target[containerKey] : null;
  }

  function getReactProps(target) {
    const propsKey = getOwnKeyByPrefix(target, "__reactProps$");
    return propsKey ? target[propsKey] : null;
  }

  function enqueueGraphValue(queue, seen, value, depth) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return;
    if (seen.has(value)) return;
    seen.add(value);
    queue.push({ value, depth });
  }

  function collectSearchRoots() {
    const seeds = [];
    const seenNodes = new Set();

    function addNode(node) {
      if (!(node instanceof Node) || seenNodes.has(node)) return;
      seenNodes.add(node);
      seeds.push(node);
    }

    const footer = document.querySelector(".composer-footer");
    const editor = document.querySelector(".ProseMirror");

    [
      document.activeElement,
      editor,
      editor?.parentElement,
      footer,
      footer?.parentElement,
      document.querySelector(".size-token-button-composer"),
      document.querySelector("[data-codex-intelligence-trigger]"),
      document.body,
    ].forEach(addNode);

    for (const start of Array.from(seenNodes)) {
      let node = start;
      let hops = 0;
      while (node && hops < 6) {
        addNode(node);
        node = node.parentNode || (node instanceof ShadowRoot ? node.host : null);
        hops += 1;
      }
    }

    return seeds.flatMap((node) => [node, getReactFiber(node), getReactProps(node), node.pmViewDesc]).filter(Boolean);
  }

  function searchObjectGraph(roots, matcher, options = {}) {
    const maxNodes = options.maxNodes ?? 9000;
    const maxDepth = options.maxDepth ?? 10;
    const seen = new WeakSet();
    const queue = [];

    roots.forEach((root) => enqueueGraphValue(queue, seen, root, 0));

    let visited = 0;
    while (queue.length && visited < maxNodes) {
      const { value, depth } = queue.shift();
      visited += 1;

      try {
        if (matcher(value)) return value;
      } catch (_) {
        // Ignore probing errors from host objects.
      }

      if (depth >= maxDepth) continue;

      if (value instanceof Node) {
        enqueueGraphValue(queue, seen, getReactFiber(value), depth + 1);
        enqueueGraphValue(queue, seen, getReactProps(value), depth + 1);
        enqueueGraphValue(queue, seen, value.pmViewDesc, depth + 1);
        continue;
      }

      if (Array.isArray(value)) {
        value.slice(0, 50).forEach((item) => enqueueGraphValue(queue, seen, item, depth + 1));
        continue;
      }

      if (value instanceof Map) {
        Array.from(value.values()).slice(0, 50).forEach((item) => enqueueGraphValue(queue, seen, item, depth + 1));
        continue;
      }

      if (value instanceof Set) {
        Array.from(value.values()).slice(0, 50).forEach((item) => enqueueGraphValue(queue, seen, item, depth + 1));
        continue;
      }

      for (const key of Object.keys(value).slice(0, 80)) {
        let nextValue;
        try {
          nextValue = value[key];
        } catch (_) {
          continue;
        }
        enqueueGraphValue(queue, seen, nextValue, depth + 1);
      }
    }

    return null;
  }

  function findReactBackedValue(matcher) {
    return searchObjectGraph(collectSearchRoots(), matcher);
  }

  // Context usage parsing
  function parseContextUsageShape(value) {
    if (!value || typeof value !== "object") return null;

    const modelContextWindow = firstFiniteNumber(
      value.model_context_window,
      value.modelContextWindow,
      value.context_window,
      value.contextWindow,
      value.window_tokens,
      value.windowTokens,
    );

    const lastUsage =
      value.last_token_usage ||
      value.lastTokenUsage ||
      value.last_usage ||
      value.lastUsage ||
      value.last;

    const totalTokens = firstFiniteNumber(
      lastUsage && lastUsage.total_tokens,
      lastUsage && lastUsage.totalTokens,
      value.total_tokens,
      value.totalTokens,
      value.tokens_used,
      value.tokensUsed,
      value.used_tokens,
      value.usedTokens,
    );

    if (!Number.isFinite(modelContextWindow) || modelContextWindow <= 0) return null;
    if (!Number.isFinite(totalTokens) || totalTokens < 0) return null;

    return {
      modelContextWindow,
      totalTokens,
    };
  }

  function buildExactContextUsage(info) {
    const parsed = parseContextUsageShape(info);
    if (!parsed) return null;
    const contextWindow = Number(parsed.modelContextWindow);
    const usedTokens = Math.min(Number(parsed.totalTokens), contextWindow);
    const remainingTokens = Math.max(contextWindow - usedTokens, 0);
    const percent = (usedTokens / contextWindow) * 100;
    if (!Number.isFinite(percent)) return null;
    return makeUsageReading(percent, usedTokens, contextWindow, true) || {
      exact: true,
      percent,
      usedTokens,
      contextWindow,
      remainingTokens,
    };
  }

  function applyContextWindowOverride(reading, config) {
    if (!reading) return null;

    const overrideWindow = Number(config && config.contextWindowOverride);
    if (!Number.isFinite(overrideWindow) || overrideWindow <= 0) return reading;
    if (!Number.isFinite(Number(reading.usedTokens))) return reading;

    const usedTokens = Number(reading.usedTokens);
    const adjustedReading = makeUsageReading((usedTokens / overrideWindow) * 100, usedTokens, overrideWindow, reading.exact);
    if (!adjustedReading) return reading;
    return {
      ...adjustedReading,
      conversationId: reading.conversationId,
      source: reading.source,
      originalContextWindow: reading.contextWindow,
    };
  }

  function buildExactContextUsageFromCandidate(value) {
    if (!value || typeof value !== "object") return null;

    const directReading = buildExactContextUsage(value);
    if (directReading) return directReading;

    if (
      value.method === "thread/tokenUsage/updated" ||
      value.type === "thread/tokenUsage/updated" ||
      value.event === "thread/tokenUsage/updated"
    ) {
      const paramsReading =
        buildExactContextUsage(value.params && value.params.tokenUsage) ||
        buildExactContextUsage(value.params);
      if (paramsReading) return paramsReading;
    }

    if (value.type === "token_count" || value.event === "token_count") {
      const infoReading = buildExactContextUsage(value.info);
      if (infoReading) return infoReading;
    }

    if (value.payload && (value.payload.type === "token_count" || value.payload.event === "token_count")) {
      const payloadReading = buildExactContextUsage(value.payload.info);
      if (payloadReading) return payloadReading;
    }

    const nestedReading = buildExactContextUsage(
      value.contextUsage || value.context_usage || value.tokenUsage || value.token_usage || value.usage,
    );
    if (nestedReading) return nestedReading;

    const infoReading = buildExactContextUsage(value.info);
    if (infoReading) return infoReading;

    return null;
  }

  function findExactContextUsage() {
    const exactCandidate = findReactBackedValue((value) => !!parseContextUsageShape(value));
    if (exactCandidate) {
      return buildExactContextUsage(exactCandidate);
    }

    const candidate = findReactBackedValue((value) => !!buildExactContextUsageFromCandidate(value));
    return candidate ? buildExactContextUsageFromCandidate(candidate) : null;
  }

  // Conversation ID reading
  function normalizeConversationId(value) {
    if (value == null) return null;
    if (typeof value !== "string" && typeof value !== "number") return null;
    const text = String(value).trim();
    if (!text) return null;
    const uuidMatch = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text);
    if (uuidMatch) return uuidMatch[0].toLowerCase();
    return text.replace(/^[a-z]+:/i, "").toLowerCase();
  }

  function normalizeConversationId(value) {
    if (value == null) return null;
    if (typeof value !== "string" && typeof value !== "number") return null;
    const text = String(value).trim();
    if (!text) return null;
    const uuidMatch = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text);
    if (uuidMatch) return uuidMatch[0].toLowerCase();
    return text.replace(/^[a-z]+:/i, "").toLowerCase();
  }

  function getElementConversationId(element) {
    for (let node = element; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement) {
      const attrValue =
        node.getAttribute("data-app-action-sidebar-thread-id") ||
        node.getAttribute("data-thread-id") ||
        node.getAttribute("data-conversation-id");
      const normalized = normalizeConversationId(attrValue);
      if (normalized) return normalized;
    }
    return null;
  }

  function readActiveConversationId() {
    const selectors = [
      `[aria-current="page"][data-app-action-sidebar-thread-id]`,
      `[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]`,
      `[aria-selected="true"][data-app-action-sidebar-thread-id]`,
      `[aria-current="page"]`,
      `[data-app-action-sidebar-thread-active="true"]`,
      `[aria-selected="true"]`,
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const conversationId = getElementConversationId(element);
      if (conversationId) return conversationId;
    }

    const threadSurface = document.querySelector("[data-thread-id], [data-conversation-id], [data-app-action-sidebar-thread-id]");
    return getElementConversationId(threadSurface);
  }

  // Capture hooks
  function inspectCandidateText(text, conversationId) {
    if (!text || text.length > MAX_CAPTURE_TEXT_LENGTH) return null;
    if (!CAPTURE_TEXT_HINT_RE.test(text)) return null;

    const parsed = JSON.parse(text);
    const usage = buildExactContextUsageFromCandidate(parsed);
    if (usage) {
      const activeId = normalizeConversationId(conversationId || readActiveConversationId());
      if (activeId) capturedUsageByConversationId.set(activeId, usage);
    }
    return usage;
  }

  function inspectCandidateValue(value, conversationId) {
    if (!value || typeof value !== "object") return null;
    const activeId = normalizeConversationId(conversationId || readActiveConversationId());
    const usage = buildExactContextUsageFromCandidate(value);
    if (usage && activeId) capturedUsageByConversationId.set(activeId, usage);
    return usage;
  }

  function installFetchCapture() {
    const patchedFlag = "__codexAutoCompactFetchPatched";
    if (window[patchedFlag] || typeof window.fetch !== "function") return;

    const nativeFetch = window.fetch.bind(window);
    window.fetch = function codexAutoCompactFetch(...args) {
      return nativeFetch(...args).then((response) => {
        try {
          const urlText = String(args[0] && (args[0].url || args[0].href || args[0]) || response.url || "");
          if (urlText && !CAPTURE_TEXT_HINT_RE.test(urlText)) return response;

          const contentType = response.headers && response.headers.get("content-type");
          const contentLength = response.headers && Number(response.headers.get("content-length"));
          const isTextLike = !contentType || /json|text|event-stream|x-ndjson/i.test(contentType);
          if (isTextLike && (!Number.isFinite(contentLength) || contentLength <= MAX_CAPTURE_TEXT_LENGTH)) {
            response.clone().text().then((text) => {
              try {
                const parsed = JSON.parse(text);
                const usage = buildExactContextUsageFromCandidate(parsed);
                if (usage) {
                  const activeId = normalizeConversationId(readActiveConversationId());
                  if (activeId) capturedUsageByConversationId.set(activeId, usage);
                }
              } catch (_) {}
            }).catch(() => {});
          }
        } catch (_) {
          return response;
        }
        return response;
      });
    };

    window[patchedFlag] = true;
  }

  function installWebSocketCapture() {
    const patchedFlag = "__codexAutoCompactWebSocketPatched";
    if (window[patchedFlag] || typeof window.WebSocket !== "function") return;

    const NativeWebSocket = window.WebSocket;
    function AutoCompactWebSocket(...args) {
      const socket = new NativeWebSocket(...args);
      socket.addEventListener("message", (event) => {
        try {
          if (typeof event.data === "string") {
            try {
              const parsed = JSON.parse(event.data);
              const usage = buildExactContextUsageFromCandidate(parsed);
              if (usage) {
                const activeId = normalizeConversationId(readActiveConversationId());
                if (activeId) capturedUsageByConversationId.set(activeId, usage);
              }
            } catch (_) {}
          } else if (event.data instanceof Blob && event.data.size <= MAX_CAPTURE_TEXT_LENGTH) {
            event.data.text().then((text) => {
              try {
                const parsed = JSON.parse(text);
                const usage = buildExactContextUsageFromCandidate(parsed);
                if (usage) {
                  const activeId = normalizeConversationId(readActiveConversationId());
                  if (activeId) capturedUsageByConversationId.set(activeId, usage);
                }
              } catch (_) {}
            }).catch(() => {});
          }
        } catch (_) {
          return;
        }
      });
      return socket;
    }

    AutoCompactWebSocket.prototype = NativeWebSocket.prototype;
    AutoCompactWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    AutoCompactWebSocket.OPEN = NativeWebSocket.OPEN;
    AutoCompactWebSocket.CLOSING = NativeWebSocket.CLOSING;
    AutoCompactWebSocket.CLOSED = NativeWebSocket.CLOSED;
    window.WebSocket = AutoCompactWebSocket;
    window[patchedFlag] = true;
  }

  function installPostMessageCapture() {
    const listenerKey = "__codexAutoCompactPostMessageListener";
    if (window[listenerKey]) return;

    const listener = (event) => {
      try {
        if (typeof event.data === "string") {
          try {
            const parsed = JSON.parse(event.data);
            const usage = buildExactContextUsageFromCandidate(parsed);
            if (usage) {
              const activeId = normalizeConversationId(readActiveConversationId());
              if (activeId) capturedUsageByConversationId.set(activeId, usage);
            }
          } catch (_) {}
        } else {
          const usage = buildExactContextUsageFromCandidate(event.data);
          if (usage) {
            const activeId = normalizeConversationId(readActiveConversationId());
            if (activeId) capturedUsageByConversationId.set(activeId, usage);
          }
        }
      } catch (_) {
        return;
      }
    };

    window.addEventListener("message", listener, true);
    window[listenerKey] = listener;
  }

  function installCaptureHooks() {
    if (captureInstalled) return;
    captureInstalled = true;
    installFetchCapture();
    installWebSocketCapture();
    installPostMessageCapture();
  }

  // Official menu usage reading
  function findOfficialMenuContextUsage() {
    const items = Array.from(document.querySelectorAll("button, [role='button'], [cmdk-item], [data-command], li, div"));
    for (const item of items) {
      if (!(item instanceof Element)) continue;
      const text = item.textContent?.replace(/\s+/g, " ").trim() || "";
      if (!text) continue;
      if (!/压缩此对话的上下文|compress this conversation/i.test(text)) continue;
      const percentMatch = /已使用\s*(\d{1,3}(?:\.\d+)?)%|used\s*(\d{1,3}(?:\.\d+)?)%/i.exec(text);
      if (!percentMatch) continue;
      const percent = firstFiniteNumber(percentMatch[1], percentMatch[2]);
      if (!Number.isFinite(percent)) continue;
      return makeUsageReading(percent, null, null, true);
    }
    return null;
  }

  // Approximate usage (fallback)
  function approximateContextUsage() {
    const text = document.body?.innerText || "";
    const normalized = text.replace(/\s+/g, " ").trim();
    const size = normalized.length;
    const estimated = Math.min(92, Math.max(4, Math.round(size / 180)));
    const inferredWindow = Math.max(1, size * 2);
    const inferredUsed = Math.max(1, Math.round((estimated / 100) * inferredWindow));
    return {
      exact: false,
      percent: estimated,
      summary: `已使用约 ${estimated}%`,
      label: `${formatTokenCount(inferredUsed)} / ${formatTokenCount(inferredWindow)}`,
      detail: `已用约 ${formatTokenCount(inferredUsed)} / ${formatTokenCount(inferredWindow)} tokens（${estimated}%）。`,
    };
  }

  // Main context usage reading
  function getContextUsage() {
    const now = Date.now();
    if (cachedContextUsage.value && now - cachedContextUsage.at < CACHE_TTL_MS) {
      return cachedContextUsage.value;
    }
    const config = readConfig();
    installCaptureHooks();
    const activeConversationId = readActiveConversationId();
    const runtimeUsage = findExactContextUsage();
    const capturedUsage = activeConversationId ? capturedUsageByConversationId.get(activeConversationId) : null;
    const officialMenuUsage = findOfficialMenuContextUsage();
    const usage = applyContextWindowOverride(
      runtimeUsage || capturedUsage || officialMenuUsage || approximateContextUsage(),
      config,
    );
    cachedContextUsage = { at: now, value: usage };
    return usage;
  }

  // ========================
  // Auto Compact logic
  // ========================

  function readConfig() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || "{}") || {};
    } catch {
      stored = {};
    }
    const runtime = window.__codexNativeAutoCompactConfig || {};
    return { ...DEFAULT_CONFIG, ...stored, ...runtime };
  }

  function log(...args) {
    if (readConfig().debug) console.log("[codex-native-auto-compact]", ...args);
  }

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle ? window.getComputedStyle(element) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)) return false;
    const rects = element.getClientRects ? element.getClientRects() : [];
    return rects.length > 0;
  }

  function elementText(element) {
    return [
      element.textContent || "",
      element.getAttribute && element.getAttribute("aria-label") || "",
      element.getAttribute && element.getAttribute("title") || "",
      element.getAttribute && element.getAttribute("data-command") || "",
      element.getAttribute && element.getAttribute("data-testid") || "",
    ].join(" ").replace(/\s+/g, " ").trim();
  }

  function clickableCandidates() {
    return Array.from(document.querySelectorAll("button, [role='button'], [cmdk-item], [data-command], li, div"))
      .filter((element) => element instanceof HTMLElement && visible(element));
  }

  function isDisabled(element) {
    return Boolean(
      element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      element.closest("[aria-disabled='true']")
    );
  }

  function shortControlText(element) {
    const text = elementText(element);
    return text.length <= 80 ? text : "";
  }

  function findBusyIndicator() {
    const busyControlRe = /stop generating|stop response|cancel response|停止生成|停止回答|停止|中止|取消生成/i;
    const controls = Array.from(document.querySelectorAll("button, [role='button'], [aria-label], [title]"))
      .filter((element) => element instanceof HTMLElement && visible(element) && !isDisabled(element));

    const busyControl = controls.find((element) => {
      const label = shortControlText(element);
      if (!label) return false;
      if (SEND_TEXT_RE.test(label)) return false;
      return busyControlRe.test(label);
    });
    if (busyControl) return { type: "control", text: shortControlText(busyControl) };

    const statusRe = /reconnecting|generating|thinking|正在重新连接|正在生成|思考中|生成中/i;
    const statuses = Array.from(document.querySelectorAll("[role='status'], [aria-live]"))
      .filter((element) => element instanceof HTMLElement && visible(element));
    const busyStatus = statuses.find((element) => {
      const text = shortControlText(element);
      return text && statusRe.test(text);
    });
    if (busyStatus) return { type: "status", text: shortControlText(busyStatus) };

    return null;
  }

  function findCompressCommand() {
    return clickableCandidates().find((element) => {
      if (isDisabled(element)) return false;
      const text = elementText(element);
      // Conversation titles in sidebar can contain "压缩" but are long;
      // actual compress buttons are short (typically < 30 chars).
      if (text.length > 30) return false;
      return COMPRESS_TEXT_RE.test(text);
    }) || null;
  }


  function findContextMenuTrigger() {
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((element) => element instanceof HTMLElement && visible(element) && !isDisabled(element));

    const candidates = buttons.filter((button) => {
      const text = elementText(button);
      if (!CONTEXT_TEXT_RE.test(text)) return false;
      if (SEND_TEXT_RE.test(text)) return false;
      if (text.length > 30) return false;
      return true;
    });

    candidates.sort((a, b) => {
      const at = elementText(a);
      const bt = elementText(b);
      const as = COMPRESS_TEXT_RE.test(at) ? 0 : at.includes("%") ? 1 : 2;
      const bs = COMPRESS_TEXT_RE.test(bt) ? 0 : bt.includes("%") ? 1 : 2;
      return as - bs;
    });

    return candidates[0] || null;
  }

  function findConfirmButton() {
    const candidates = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((element) => element instanceof HTMLElement && visible(element) && !isDisabled(element));

    return candidates.find((element) => CONFIRM_TEXT_RE.test(elementText(element))) || null;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getAttemptDecision(reading, config, conversationId) {
    if (!reading || !Number.isFinite(Number(reading.percent))) {
      return { ok: false, code: "no-usage" };
    }

    const percent = Number(reading.percent);
    const threshold = Number(config.thresholdUsedPercent);
    const remainingTokens = Number(reading.remainingTokens);
    const minRemainingTokens = Number(config.minRemainingTokensBeforeCompact);
    const hitPercentThreshold = Number.isFinite(threshold) && percent >= threshold;
    const hitRemainingThreshold =
      Number.isFinite(remainingTokens) &&
      Number.isFinite(minRemainingTokens) &&
      minRemainingTokens > 0 &&
      remainingTokens <= minRemainingTokens;

    if (!hitPercentThreshold && !hitRemainingThreshold) {
      return {
        ok: false,
        code: "below-threshold",
        percent,
        threshold,
        remainingTokens: Number.isFinite(remainingTokens) ? remainingTokens : null,
        minRemainingTokens: Number.isFinite(minRemainingTokens) ? minRemainingTokens : null,
      };
    }

    const lastAttemptAt = state.lastAttemptByConversationId.get(conversationId) || 0;
    const cooldownMs = Number(config.cooldownMs);
    const elapsedMs = Date.now() - lastAttemptAt;
    if (Number.isFinite(cooldownMs) && elapsedMs < cooldownMs) {
      return { ok: false, code: "cooldown", elapsedMs, cooldownMs };
    }

    if (config.onlyWhenIdle) {
      const busyIndicator = findBusyIndicator();
      if (busyIndicator) {
        return { ok: false, code: "busy", busyIndicator };
      }
    }

    return {
      ok: true,
      code: hitPercentThreshold ? "percent-threshold" : "remaining-threshold",
      percent,
      threshold,
      remainingTokens: Number.isFinite(remainingTokens) ? remainingTokens : null,
      minRemainingTokens: Number.isFinite(minRemainingTokens) ? minRemainingTokens : null,
    };
  }

  async function verifyCompactResult(beforeReading, config) {
    if (!config.verifyAfterCompact || config.dryRun) return null;
    await sleep(Math.max(0, Number(config.verifyDelayMs) || 0));

    const beforeUsedTokens = Number(beforeReading && beforeReading.usedTokens);
    const minReduction = Math.max(0, Number(config.verifyMinReductionTokens) || 0);
    const timeoutMs = Math.max(0, Number(config.verifyTimeoutMs) || 0);
    const pollIntervalMs = Math.max(500, Number(config.verifyPollIntervalMs) || 3000);
    const deadline = Date.now() + timeoutMs;
    let afterReading = null;
    let reductionTokens = null;
    let ok = false;

    do {
      cachedContextUsage = { at: 0, value: null };
      afterReading = getContextUsage();
      const afterUsedTokens = Number(afterReading && afterReading.usedTokens);
      reductionTokens =
        Number.isFinite(beforeUsedTokens) && Number.isFinite(afterUsedTokens)
          ? beforeUsedTokens - afterUsedTokens
          : null;

      ok =
        reductionTokens == null
          ? Number(afterReading && afterReading.percent) < Number(beforeReading && beforeReading.percent)
          : reductionTokens >= minReduction;

      if (ok || Date.now() >= deadline) break;
      await sleep(pollIntervalMs);
    } while (true);

    return {
      ok,
      code: ok ? "usage-reduced" : "usage-not-reduced",
      before: beforeReading,
      after: afterReading,
      reductionTokens,
      minReductionTokens: minReduction,
    };
  }

  async function clickNativeCompact(config, reason) {
    const directCommand = findCompressCommand();
    if (directCommand) {
      if (!config.dryRun) directCommand.click();
      await sleep(Number(config.confirmDelayMs));
      const confirmButton = findConfirmButton();
      if (confirmButton && !config.dryRun) confirmButton.click();
      return { ok: true, route: "direct-command", reason };
    }

    const trigger = findContextMenuTrigger();
    if (!trigger) return { ok: false, route: "no-trigger", reason };

    if (!config.dryRun) trigger.click();
    await sleep(Number(config.menuOpenDelayMs));

    const menuCommand = findCompressCommand();
    if (!menuCommand) return { ok: false, route: "opened-menu-no-command", reason };

    if (!config.dryRun) menuCommand.click();
    await sleep(Number(config.confirmDelayMs));
    const confirmButton = findConfirmButton();
    if (confirmButton && !config.dryRun) confirmButton.click();
    return { ok: true, route: "opened-menu-command", reason };
  }

  async function tick() {
    if (state.destroyed || state.running) return null;
    state.running = true;
    try {
      const config = readConfig();
      const reading = getContextUsage();
      const conversationId = String(reading?.conversationId || readActiveConversationId() || "__unknown__");
      const decision = getAttemptDecision(reading, config, conversationId);
      if (!decision.ok) {
        if (decision.code !== "below-threshold") {
          state.lastSkip = { at: new Date().toISOString(), conversationId, ...decision };
          log("skip", state.lastSkip);
        }
        return null;
      }

      state.lastAttemptByConversationId.set(conversationId, Date.now());
      const result = await clickNativeCompact(config, {
        conversationId,
        percent: reading.percent,
        threshold: Number(config.thresholdUsedPercent),
        remainingTokens: reading.remainingTokens,
        minRemainingTokens: Number(config.minRemainingTokensBeforeCompact),
        trigger: decision.code,
        source: reading.exact ? "react-graph" : "approximate",
      });
      const verification = result.ok ? await verifyCompactResult(reading, config) : null;
      state.lastAction = { at: new Date().toISOString(), ...result, verification };
      log("attempt", state.lastAction);
      return state.lastAction;
    } finally {
      state.running = false;
    }
  }

  function start() {
    window.clearInterval(state.timer);
    state.destroyed = false;
    state.timer = window.setInterval(tick, Math.max(1000, Number(readConfig().pollIntervalMs) || 5000));
    tick();
  }

  // Export API
  window[API_KEY] = {
    version: "0.3.0",
    start,
    tick,
    readConfig,
    readUsage: getContextUsage,
    findCompressCommand,
    findContextMenuTrigger,
    getState() {
      return {
        running: state.running,
        lastAction: state.lastAction,
        lastSkip: state.lastSkip,
        lastAttemptConversationIds: Array.from(state.lastAttemptByConversationId.keys()),
      };
    },
    destroy() {
      state.destroyed = true;
      window.clearInterval(state.timer);
      delete window[API_KEY];
    },
  };

  start();
})();
