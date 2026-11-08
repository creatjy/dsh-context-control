/**
 * AI 建议的单一事实源：作用域矩阵、受保护项、类型/长度校验。
 * 只做纯数据校验，不读 store、不调模型。
 */

export const TYPE_SCOPE_MATRIX = Object.freeze({
  cap: Object.freeze({ global: true, project: true, parts: false, session: true, item: true }),
  section: Object.freeze({ global: true, project: true, parts: true, session: true, item: true }),
  context: Object.freeze({ global: false, project: false, parts: true, session: false, item: false }),
  tool: Object.freeze({ global: true, project: true, parts: true, session: true, item: true }),
});

export const PROTECTED = Object.freeze({
  tools: new Set([
    "read", "write", "edit", "bash", "glob", "grep",
    "terminal_open", "terminal_send", "terminal_read", "terminal_close",
    "terminal_signal", "terminal_list",
    "run_code",
    "compress", "decompress", "search_context", "acp_status",
    "acp_read_original_image", "acp_cache",
    "ask_user_question",
  ]),
  toolPrefixes: Object.freeze(["context_control_", "ops_", "acp_"]),
  caps: new Set([
    "plugin:context-control",
    "plugin:dsh-ops",
    "plugin:billion-context",
    "plugin:terminal",
  ]),
  sections: new Set(["context-control:brief"]),
});

export function matrixSupports(type, scope) {
  return Boolean(TYPE_SCOPE_MATRIX[type]?.[scope]);
}

export function isProtectedTool(name) {
  const value = String(name ?? "");
  if (PROTECTED.tools.has(value)) return true;
  return PROTECTED.toolPrefixes.some((prefix) => value.startsWith(prefix));
}

export function isProtectedCap(key) {
  return PROTECTED.caps.has(String(key ?? ""));
}

export function isProtectedSection(name) {
  return PROTECTED.sections.has(String(name ?? ""));
}

/**
 * 保护项校验。cap 必须由调用方提供 expandCap 展开后再逐项判断；
 * 不能只看 cap key，否则 plugin:dsh-ops 整包就能绕过工具级保护。
 */
export function checkGuard(item, { expandCap } = {}) {
  const type = String(item?.type ?? "");
  const key = String(item?.key ?? item?.name ?? "");
  const action = String(item?.action ?? "keep");
  const blocked = [];

  if (type === "tool" && isProtectedTool(key)) blocked.push("工具受保护");
  if (type === "section" && isProtectedSection(key)) blocked.push("提示段受保护");
  if (type === "cap") {
    if (isProtectedCap(key)) blocked.push("能力包受保护");
    if (typeof expandCap === "function") {
      const expanded = expandCap(key);
      for (const section of expanded?.sections ?? []) {
        if (isProtectedSection(section)) blocked.push(`展开后提示段受保护：${section}`);
      }
      for (const tool of expanded?.tools ?? []) {
        if (isProtectedTool(tool)) blocked.push(`展开后工具受保护：${tool}`);
      }
    }
  }

  if (blocked.length > 0 && action !== "keep") {
    return { ok: false, action: "keep", blocked: blocked.join("；"), reason: blocked.join("；") };
  }
  return { ok: true, action, blocked: null, reason: null };
}

const ACTIONS = new Set(["keep", "brief", "hide", "on", "off", "rewrite"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const RISK = new Set(["low", "medium", "high"]);

function str(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function num(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/**
 * 过滤模型输出：未知 id、非法类型、矩阵不支持、保护项、超长文本都丢弃或降级。
 * savedTokens 不在这里采信，必须由服务端按真实 token 重算。
 */
export function sanitizeSuggestionItem(raw, { items = [], scope = "global", expandCap } = {}) {
  const id = str(raw?.id, 160).trim();
  if (!id) return { item: null, warning: "缺少 id" };
  const known = items.find((entry) => entry.id === id || entry.name === raw?.name);
  if (!known) return { item: null, warning: `未知条目：${id}` };

  const type = String(raw?.type ?? known.type ?? "");
  const name = String(known.name ?? raw?.name ?? "");
  const action = ACTIONS.has(raw?.action) ? raw.action : "keep";
  const matrix = matrixSupports(type, scope);
  const guard = checkGuard({ type, key: name, action }, { expandCap });

  const text = action === "rewrite" ? str(raw?.text, 2_000) : null;
  if (action === "rewrite" && !text) return { item: null, warning: `改写缺少文本：${name}` };
  if (action === "rewrite" && type !== "section" && type !== "context") {
    return { item: null, warning: `不支持改写类型：${type}` };
  }

  return {
    item: {
      id,
      type,
      name,
      action: matrix ? guard.action : "keep",
      text,
      reason: str(raw?.reason, 500),
      confidence: CONFIDENCE.has(raw?.confidence) ? raw.confidence : "low",
      risk: RISK.has(raw?.risk) ? raw.risk : "high",
      currentTokens: num(known.tokens ?? raw?.currentTokens),
      savedTokens: 0,
      editable: type === "section" || type === "context",
      blocked: matrix ? guard.blocked : "该作用域不支持此类型",
      impact: null,
      warning: matrix ? null : `矩阵不支持：${type}@${scope}`,
    },
    warning: matrix ? null : `矩阵不支持：${type}@${scope}`,
  };
}
