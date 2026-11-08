import { createHash, randomUUID } from "node:crypto";
import { estimateTokens } from "../tokens.js";
import { sanitizeSuggestionItem } from "./schema.js";
import { callJson, withTimeout } from "./llm.js";

const SUGGESTION_TTL = 15 * 60 * 1000;
const UNDO_TTL = 60 * 60 * 1000;
const MAX_CACHE = 20;
const MAX_UNDO = 20;
const MAX_ITEMS = 60;
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 120_000;

function fail(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function fingerprintOf(value) {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 32);
}

function savedFor(item, text) {
  const tokens = Math.max(0, Number(item.currentTokens ?? item.tokens ?? 0));
  if (item.action === "hide" || item.action === "off") return tokens;
  if (item.action === "brief") return Math.max(0, tokens - 20);
  if (item.action === "rewrite") return Math.max(0, tokens - estimateTokens(text ?? item.text ?? ""));
  return 0;
}

function suggestionId() {
  return `sug-${randomUUID()}`;
}

function undoId() {
  return `undo-${randomUUID()}`;
}

function trimText(value, max = 500) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function buildSystemPrompt() {
  return [
    "你是 DeepSeek Harness 的上下文审计助手。",
    "你只输出 JSON，不解释。目标是在不破坏任务能力的前提下，减少每次请求的 token。",
    "输入是一个作用域内的条目列表。每条都有 id/type/name/tokens/enabled/editable/scope。",
    "对每条给一个 action：keep（保留）、brief（只留一句话简介）、hide（不加载）、on（加载）、off（关闭）、rewrite（改写文本，仅 section/context 可改写）。",
    "必须给出 reason（中文，具体到观察到的重复/重叠/未使用证据）、confidence（high/medium/low）、risk（low/medium/high）。",
    "低置信度或高风险的项应保持 keep。不要建议关闭文件读写、shell、压缩、上下文管控自身等基础能力。",
    '输出格式：{"items":[{"id":"...","action":"keep","text":null,"reason":"...","confidence":"high","risk":"low"}],"notes":"可选的一句话"}。',
  ].join("\n");
}

function buildUserPrompt(evidence) {
  const items = evidence.items.slice(0, MAX_ITEMS).map((item) => ({
    id: item.id,
    type: item.type,
    name: item.name,
    tokens: item.tokens,
    enabled: item.enabled !== false,
    editable: item.editable === true,
    scope: evidence.scope,
  }));
  return JSON.stringify(
    {
      scope: evidence.scope,
      scopeKey: evidence.scopeKey,
      focus: trimText(evidence.focus, 300) || null,
      items,
      instructions: "只返回 items；不要编造 id；无法判断就 keep。",
    },
    null,
    2,
  );
}

async function resolveRoute(ctx, agent) {
  const direct = agent?.model?.current?.();
  let candidate = null;
  if (direct?.provider && direct?.model) candidate = { provider: direct.provider, model: direct.model, source: "agent" };
  if (!candidate) {
    try {
      const selection = ctx?.get?.("agentDefaultModel")?.currentSelection?.();
      if (selection?.provider && selection?.model) {
        candidate = { provider: selection.provider, model: selection.model, source: "default" };
      }
    } catch {
      /* 该宿主没有 agentDefaultModel 服务 */
    }
  }
  if (!candidate) return null;

  let llm = null;
  try {
    llm = ctx?.get?.("llm") ?? null;
  } catch {
    llm = null;
  }
  if (!llm || typeof llm.listProviders !== "function") return candidate;

  let providers = [];
  try {
    providers = await llm.listProviders();
  } catch {
    return candidate;
  }
  if (!Array.isArray(providers) || providers.length === 0) return candidate;
  if (providers.some((provider) => provider?.id === candidate.provider)) return candidate;

  // 当前会话的 provider 可能只接入了 agent 侧，没有注册到 llm 服务；
  // 这时退到宿主已注册的 provider，而不是让 UI 直接报 NO_ADAPTER。
  const fallback = providers.find((provider) => provider?.id === "deepseek-official")
    ?? providers.find((provider) => /deepseek/i.test(String(provider?.id ?? "")))
    ?? providers[0];
  if (!fallback?.id) return null;
  try {
    const listed = await llm.listModels(fallback.id);
    const model = Array.isArray(listed) ? listed.find((entry) => entry?.id)?.id ?? listed[0]?.id : null;
    if (model) return { provider: fallback.id, model, source: "fallback" };
  } catch {
    /* 列不出模型时不猜 */
  }
  return null;
}

/**
 * AI 建议服务：collect 由宿主注入，负责把当前作用域整理成 items + 指纹。
 * 模型调用只走宿主 ctx.llm，不另建 provider。
 */
export function createAiService({ store, collect, ctx, llm, getLlm, clock = Date.now }) {
  if (!store) throw new Error("createAiService 需要 store");
  if (typeof collect !== "function") throw new Error("createAiService 需要 collect");

  const cache = new Map();
  const undos = new Map();
  const fingerprints = new Map();
  const busy = new Set();
  const calls = [];

  function prune() {
    const now = clock();
    for (const [id, entry] of cache) {
      if (now - entry.at > SUGGESTION_TTL) cache.delete(id);
    }
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    for (const [id, entry] of undos) {
      if (now - entry.at > UNDO_TTL) undos.delete(id);
    }
    while (undos.size > MAX_UNDO) undos.delete(undos.keys().next().value);
    for (const [key, entry] of fingerprints) {
      if (now - entry.at > SUGGESTION_TTL) fingerprints.delete(key);
    }
    while (fingerprints.size > MAX_CACHE) fingerprints.delete(fingerprints.keys().next().value);
    while (calls.length && now - calls[0] > 60 * 60 * 1000) calls.shift();
  }

  function rateLimit() {
    prune();
    const now = clock();
    const lastMinute = calls.filter((at) => now - at < 60 * 1000).length;
    if (lastMinute >= 6) throw fail("rate-limit", "一分钟内最多 6 次 AI 建议，请稍后再试。", 429);
    if (calls.length >= 20) throw fail("rate-limit", "一小时内最多 20 次 AI 建议，请稍后再试。", 429);
    calls.push(now);
  }

  function state({ sessionId, route } = {}) {
    const ai = store.ai();
    return {
      enabled: ai.enabled === true,
      privacyAccepted: Boolean(ai.privacyAcceptedAt),
      privacyAcceptedAt: ai.privacyAcceptedAt ?? null,
      impactScan: ai.impactScan ?? "off",
      impactScanAvailable: ai.impactScan !== "off",
      available: Boolean(route),
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      routeSource: route?.source ?? "none",
      reason: route ? null : "没有可用的模型路由；请先配置模型或 agentDefaultModel。",
      busyScopes: [...busy],
      limits: { maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS, maxItems: MAX_ITEMS },
    };
  }

  async function suggest(body = {}, { signal } = {}) {
    const ai = store.ai();
    if (!ai.enabled) throw fail("ai-disabled", "AI 建议未启用。", 403);
    if (!ai.privacyAcceptedAt) throw fail("privacy-required", "启用 AI 建议前需要确认隐私范围：条目元数据会发送给当前模型。", 403);

    const evidence = await collect({ ...body, impactScan: ai.impactScan });
    if (!evidence?.items?.length) throw fail("empty-scope", "这个作用域没有可分析的条目。");
    const route = evidence.route ?? await resolveRoute(ctx, evidence.agent);
    if (!route) throw fail("no-route", "当前会话没有可用的模型路由；请先配置模型或 agentDefaultModel。", 409);

    const scopeKey = String(evidence.scopeKey ?? `${evidence.scope}:${evidence.scopeId ?? ""}`);
    if (busy.has(scopeKey)) throw fail("ai-busy", "同一作用域已有 AI 任务在运行。", 409);
    rateLimit();

    const fp = fingerprintOf({
      scopeKey,
      revision: evidence.revision ?? store.revision,
      items: evidence.items.map((item) => [item.id, item.tokens, item.enabled, item.currentRule, item.currentValue]),
      route,
      impactScan: ai.impactScan,
    });
    const cached = fingerprints.get(scopeKey);
    if (cached && cached.fp === fp && clock() - cached.at < SUGGESTION_TTL) {
      return { ...cached.result, cached: true };
    }

    busy.add(scopeKey);
    const timeout = withTimeout(signal, TIMEOUT_MS);
    try {
      const raw = await callJson({
        llm: llm ?? getLlm?.() ?? ctx?.get?.("llm"),
        route,
        system: buildSystemPrompt(),
        user: buildUserPrompt({ ...evidence, focus: body.focus }),
        signal: timeout.signal,
        maxTokens: MAX_TOKENS,
        timeoutMs: TIMEOUT_MS,
      });
      return finishSuggestion(raw, evidence, route, scopeKey, fp);
    } finally {
      timeout.dispose();
      busy.delete(scopeKey);
    }
  }

  function finishSuggestion(raw, evidence, route, scopeKey, fp) {
    const rawItems = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
    if (!rawItems.length) throw fail("bad-output", "模型没有返回可用的建议。", 502);
    const items = [];
    const warnings = [];
    for (const candidate of rawItems.slice(0, MAX_ITEMS)) {
      const { item, warning } = sanitizeSuggestionItem(
        { ...candidate, currentTokens: candidate?.currentTokens },
        { items: evidence.items, scope: evidence.scope },
      );
      if (warning) warnings.push(warning);
      if (!item) continue;
      item.savedTokens = savedFor({ ...item, currentTokens: item.currentTokens }, item.text);
      items.push(item);
    }
    if (!items.length) throw fail("bad-output", "模型返回的条目都不可用。", 502);

    const counts = { keep: 0, brief: 0, hide: 0, on: 0, off: 0, rewrite: 0 };
    let saved = 0;
    for (const item of items) {
      counts[item.action] = (counts[item.action] ?? 0) + 1;
      saved += item.savedTokens;
    }
    const result = {
      suggestion: {
        id: suggestionId(),
        createdAt: new Date(clock()).toISOString(),
        scope: evidence.scope,
        scopeKey,
        writeScope: evidence.writeScope ?? evidence.scope,
        scopeId: evidence.scopeId ?? null,
        projectId: evidence.projectId ?? null,
        sessionId: evidence.sessionId ?? null,
        modeId: evidence.modeId ?? null,
        revision: evidence.revision ?? store.revision,
        fingerprint: fp,
        provider: route.provider,
        model: route.model,
        summary: `保留 ${counts.keep} · 简介 ${counts.brief} · 隐藏 ${counts.hide}${counts.rewrite ? ` · 改写 ${counts.rewrite}` : ""}，预计少发 ≈${saved}`,
        counts,
        savedTokens: saved,
        totalTokens: evidence.items.reduce((sum, item) => sum + Number(item.tokens ?? 0), 0),
        items,
        notes: trimText(raw?.notes, 500) || null,
        partial: warnings.length > 0,
        warnings: warnings.slice(0, 12),
        impacts: Array.isArray(evidence.impacts) ? evidence.impacts.slice(0, 30) : [],
      },
      evidence,
      at: clock(),
    };
    cache.set(result.suggestion.id, result);
    fingerprints.set(scopeKey, { fp, at: clock(), result: result.suggestion });
    prune();
    return result.suggestion;
  }

  function opFor(item, suggestion) {
    const writeScope = suggestion.writeScope;
    const scopeId = suggestion.scopeId;
    if (item.type === "cap") {
      const value = item.action === "hide" || item.action === "off" ? "hidden" : item.action === "brief" ? false : true;
      if (writeScope === "session") {
        return { op: "setSessionCap", sessionId: suggestion.sessionId, key: item.name, value };
      }
      return { op: "setCap", scopeId: writeScope === "global" ? "global" : scopeId, key: item.name, value };
    }

    const kind = item.type === "tool" ? "tools" : item.type === "section" ? "sections" : "contexts";
    let patch = null;
    if (item.action === "hide") patch = { enabled: false, hidden: true };
    else if (item.action === "brief" || item.action === "off") patch = { enabled: false, hidden: false };
    else if (item.action === "on") patch = { enabled: true, hidden: false };
    else if (item.action === "rewrite") patch = { text: item.text };
    if (!patch) return null;

    if (writeScope === "session") {
      return { op: "setSessionRule", sessionId: suggestion.sessionId, kind, key: item.name, patch };
    }
    if (writeScope === "parts") {
      return { op: "setRule", modeId: suggestion.modeId, kind, key: item.name, patch };
    }
    return { op: "setScopeRule", scopeId: writeScope === "global" ? "global" : scopeId, kind, key: item.name, patch };
  }

  function inverseFor(item, suggestion) {
    const writeScope = suggestion.writeScope;
    if (item.type === "cap") {
      if (writeScope === "session") {
        return { op: "setSessionCap", sessionId: suggestion.sessionId, key: item.name, value: item.currentValue ?? null };
      }
      return { op: "setCap", scopeId: writeScope === "global" ? "global" : suggestion.scopeId, key: item.name, value: item.currentValue ?? null };
    }
    const kind = item.type === "tool" ? "tools" : item.type === "section" ? "sections" : "contexts";
    const rule = item.currentRule ?? null;
    if (writeScope === "session") {
      return { op: "setSessionRule", sessionId: suggestion.sessionId, kind, key: item.name, patch: rule, replace: true };
    }
    if (writeScope === "parts") {
      return { op: "setRule", modeId: suggestion.modeId, kind, key: item.name, patch: rule, replace: true };
    }
    return { op: "setScopeRule", scopeId: writeScope === "global" ? "global" : suggestion.scopeId, kind, key: item.name, patch: rule, replace: true };
  }

  async function apply(body = {}) {
    const entry = cache.get(String(body.suggestionId ?? ""));
    if (!entry) throw fail("suggestion-expired", "建议已过期，请重新分析。", 409);
    if (body.confirm !== true) throw fail("confirm-required", "应用前需要确认。", 400);
    const suggestion = entry.suggestion;
    const ids = Array.isArray(body.itemIds) && body.itemIds.length
      ? new Set(body.itemIds.map(String))
      : new Set(suggestion.items.filter((item) => item.action !== "keep").map((item) => item.id));
    const selected = suggestion.items.filter((item) => ids.has(item.id) && item.action !== "keep");
    if (!selected.length) return { applied: [], skipped: [], suggestionId: suggestion.id, revision: store.revision };

    const blocked = selected.filter((item) => item.blocked);
    if (blocked.length) {
      throw fail("guard-blocked", `有受保护项不能应用：${blocked.map((item) => item.name).join("、")}`, 403);
    }

    const ops = selected.map((item) => ({ item, op: opFor(item, suggestion) })).filter((entry) => entry.op);
    if (!ops.length) return { applied: [], skipped: selected.map((item) => item.name), suggestionId: suggestion.id, revision: store.revision };
    try {
      await store.applyOps(ops.map((entry) => entry.op), { revision: suggestion.revision });
    } catch (error) {
      if (/revision|冲突|过期|修改/i.test(String(error?.message ?? ""))) {
        throw fail("stale-suggestion", "配置已变化，请重新分析后再应用。", 409);
      }
      throw error;
    }

    const token = undoId();
    undos.set(token, {
      at: clock(),
      suggestionId: suggestion.id,
      sessionId: suggestion.sessionId,
      expectedRevision: store.revision,
      ops: selected.map((item) => inverseFor(item, suggestion)),
      names: selected.map((item) => item.name),
    });
    prune();
    cache.delete(suggestion.id);
    return {
      applied: selected.map((item) => ({ id: item.id, name: item.name, action: item.action, savedTokens: item.savedTokens })),
      skipped: suggestion.items.filter((item) => ids.has(item.id) && item.action === "keep").map((item) => item.name),
      suggestionId: suggestion.id,
      undoToken: token,
      revision: store.revision,
    };
  }

  async function undo(body = {}) {
    const token = String(body.undoToken ?? "");
    const entry = undos.get(token);
    if (!entry) throw fail("undo-expired", "撤销已过期。", 409);
    if (entry.expectedRevision !== store.revision) {
      throw fail("stale-undo", "配置在撤销前又发生了变化，无法安全撤销。", 409);
    }
    await store.applyOps(entry.ops);
    undos.delete(token);
    return { restored: entry.names, revision: store.revision };
  }

  function suggestion(id) {
    return cache.get(String(id ?? ""))?.suggestion ?? null;
  }

  return { state, suggest, apply, undo, suggestion, resolveRoute };
}

export { resolveRoute };
