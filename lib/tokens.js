/**
 * Token 估算：不联网、不加载分词器。
 *
 * DSH 自己有 `tokenMeter`，会话消息（工具结果 / 助手消息 …）用的是它的真实统计；
 * 这里的启发式只用于「系统提示段落 / 工具定义」这类还没进计量器、也没法精确
 * 计费的文本——所以界面上统一标 ≈，不冒充精确值。
 *
 * 口径：
 *   - CJK（含假名、谚文、全角符号）约 1 字 = 1 token；
 *   - 其余字符约 3.6 字符 = 1 token（英文单词平均 4.5 字符 ≈ 1.3 token）。
 */

const CJK_MIN = 0x2e80;

/** 估算一段文本的 token 数；空文本为 0。 */
export function estimateTokens(text) {
  if (!text) return 0;
  const value = typeof text === "string" ? text : String(text);
  let cjk = 0;
  let other = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= CJK_MIN || cp === 0x201c || cp === 0x201d) cjk += 1;
    else other += 1;
  }
  return Math.round(cjk + other / 3.6);
}

/** JSON 化后估算（工具 schema、参数）。 */
export function estimateJsonTokens(value) {
  try {
    return estimateTokens(JSON.stringify(value ?? null));
  } catch {
    return 0;
  }
}

/** 12345 → "12.3k"；用于紧凑的角标。 */
export function formatTokens(tokens) {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (n < 1000) return String(n);
  if (n < 100000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** 文本首行摘要，用于列表里的一行预览。 */
export function previewOf(text, limit = 120) {
  if (!text) return "";
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
