/**
 * 宿主 llm 的最小适配层：只负责「发一次请求、收完整 JSON 文本」。
 * 不在插件内重试；重试交给宿主重试策略，避免同一次点击重复计费。
 */

export function stripJsonFence(text) {
  const value = String(text ?? "").trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start >= 0 && end > start) return value.slice(start, end + 1);
  return value;
}

export function parseModelJson(text) {
  try {
    return JSON.parse(stripJsonFence(text));
  } catch {
    const error = new Error(`模型返回的不是合法 JSON：${String(text ?? "").slice(0, 240)}`);
    error.code = "bad-json";
    throw error;
  }
}

/**
 * 消费 llm.stream 的事件。兼容 text-delta 与字符串 chunk；
 * finish.kind=error/aborted 会抛出对应错误，空文本视为失败。
 */
export async function collectStream(stream, { signal } = {}) {
  let text = "";
  let finish = null;
  for await (const event of stream ?? []) {
    if (signal?.aborted) {
      const reason = signal.reason;
      if (reason?.code === "llm-timeout") throw reason;
      const error = new Error(reason?.message || "已取消");
      error.code = reason?.code || "aborted";
      throw error;
    }
    const type = String(event?.type ?? "");
    if (type === "text-delta") {
      text += event?.delta?.text ?? event?.text ?? event?.delta ?? "";
      continue;
    }
    if (type === "text") {
      text += event?.text ?? "";
      continue;
    }
    if (type === "finish") {
      finish = event?.reason ?? event?.finish ?? event;
      break;
    }
  }
  const kind = String(finish?.kind ?? "stop");
  if (kind === "error") {
    const error = new Error(finish?.failure?.message ?? "模型调用失败");
    error.code = finish?.failure?.code ?? "llm-error";
    throw error;
  }
  if (kind === "aborted") {
    const error = new Error("模型调用已取消");
    error.code = "aborted";
    throw error;
  }
  if (kind === "max-tokens") {
    const error = new Error("模型输出被 maxTokens 截断，请重试或缩小分析范围。");
    error.code = "max-tokens";
    throw error;
  }
  if (!text.trim()) {
    const error = new Error("模型没有返回内容，请重试。");
    error.code = "empty-output";
    throw error;
  }
  return text;
}

export async function callJson({ llm, route, system, user, signal, maxTokens = 4096, timeoutMs = 60_000 }) {
  if (!llm || typeof llm.stream !== "function") {
    const error = new Error("宿主没有提供 llm 服务");
    error.code = "llm-unavailable";
    throw error;
  }
  const messages = [
    { role: "system", content: [{ type: "text", text: system }] },
    { role: "user", content: [{ type: "text", text: user }] },
  ];
  const attempt = async (limit, timeout) => {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      maxTokens: limit,
      temperature: 0.2,
      signal,
    });
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("模型调用超时");
        error.code = "llm-timeout";
        reject(error);
      }, timeout);
      if (timer?.unref) timer.unref();
    });
    try {
      const text = await Promise.race([collectStream(stream, { signal }), deadline]);
      return parseModelJson(text);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    return await attempt(maxTokens, timeoutMs);
  } catch (error) {
    // 空输出/被思考耗尽 token 时，放宽一次上限再试；其他错误不重试，避免重复计费。
    if (error?.code !== "empty-output" && error?.code !== "max-tokens") throw error;
    return attempt(Math.max(maxTokens * 2, 8192), Math.max(timeoutMs, 90_000));
  }
}

export function withTimeout(parentSignal, ms = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error(`模型调用超时（${Math.round(ms / 1000)} 秒），可以重试或缩小分析范围。`);
    error.code = "llm-timeout";
    controller.abort(error);
  }, ms);
  if (timer?.unref) timer.unref();
  if (parentSignal) {
    if (parentSignal.aborted) {
      const error = new Error("已取消");
      error.code = "aborted";
      controller.abort(error);
    } else parentSignal.addEventListener("abort", () => {
      const error = new Error("已取消");
      error.code = "aborted";
      controller.abort(error);
    }, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}
