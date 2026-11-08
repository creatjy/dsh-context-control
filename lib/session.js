/**
 * 会话侧的两件事：
 *   1. 用 DSH 自己的 `tokenMeter` 把「这个会话现在到底占了多少」按事件类型拆开
 *      （工具结果 / 助手消息 / 用户消息 …），给会话内入口显示真实数字。
 *   2. 把「勾选要压缩的模块」变成一条提示词，通过 `sessionController.prompt`
 *      投递进当前会话，让模型针对性压缩（不硬改会话日志，安全且可回滚）。
 */
import { randomUUID } from "node:crypto";

const GROUP_LABELS = {
  toolResults: "工具结果",
  assistant: "助手消息",
  user: "用户消息",
  systemMsgs: "系统消息",
  developer: "开发者消息",
  toolCalls: "工具调用",
  other: "其它",
};

const GROUP_ORDER = ["toolResults", "assistant", "user", "systemMsgs", "developer", "toolCalls", "other"];

/** 取服务：`ctx.get(name)` 拿不到时再退到属性访问（不同版本暴露方式不一样）。 */
export function getService(ctx, name) {
  try {
    if (typeof ctx.get === "function") {
      const service = ctx.get(name);
      if (service) return service;
    }
  } catch {
    /* 服务没装：继续往下试 */
  }
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}

/** SessionId → Agent（拿 agent.session 才能调 tokenMeter）。 */
export async function resolveAgent(ctx, sessionId) {
  if (!sessionId) return null;
  const agents = getService(ctx, "agents");
  if (agents && typeof agents.get === "function") {
    try {
      const agent = agents.get(sessionId);
      if (agent) return agent;
    } catch {
      /* 继续尝试 sessionController */
    }
  }
  const controller = getService(ctx, "sessionController");
  if (controller && typeof controller.resolveAgent === "function") {
    try {
      const result = await controller.resolveAgent(sessionId);
      const agent = result?.agent ?? result?.value?.agent ?? (result?.session ? result : null);
      if (agent) return agent;
    } catch {
      /* 会话可能还没启动 */
    }
  }
  return null;
}

function classifyEvent(type) {
  switch (type) {
    case "tool/result":
      return "toolResults";
    case "assistant/message":
      return "assistant";
    case "user/message":
      return "user";
    case "system/message":
      return "systemMsgs";
    case "developer/message":
      return "developer";
    case "tool/call":
      return "toolCalls";
    default:
      return "other";
  }
}

/**
 * 会话占用拆解。
 * 说明：nodes 是 surface 节点，seq 指回会话事件；tokens 是计量器的结果
 * （有 usage 基线时是真实值，否则是估算），所以这里不加 ≈ 也能直接用。
 */
export function sessionBreakdown(ctx, agent) {
  const meter = getService(ctx, "tokenMeter");
  const session = agent?.session;
  if (!meter || typeof meter.measure !== "function" || !session) return null;

  let measurement;
  try {
    measurement = meter.measure(session);
  } catch {
    return null;
  }
  if (!measurement) return null;

  const entries = [];
  for (const node of measurement.nodes ?? []) {
    let type = "other";
    try {
      type = session.eventAt?.(node.seq)?.type ?? "other";
    } catch {
      type = "other";
    }
    entries.push({ seq: node.seq, tokens: Number(node.tokens ?? 0), key: classifyEvent(type) });
  }

  let pressure = null;
  try {
    pressure = meter.contextPressure?.(session) ?? null;
  } catch {
    pressure = null;
  }

  // 计量器的 totalTokens 是「整条日志累计」（压缩过的历史也算在内），
  // 而 DSH 界面上的占用是「当前窗口」：日志的尾部，从最新一条往前累到 pressureTokens。
  // 两个数差得远是正常的，所以这里按窗口切一份，让界面上的数字对得上。
  const logTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  const pressureTokens = Number(pressure?.pressureTokens ?? 0);
  let windowEntries = entries;
  let windowTokens = logTokens;
  if (pressureTokens > 0 && pressureTokens < logTokens) {
    let acc = 0;
    let start = entries.length;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      acc += entries[i].tokens;
      start = i;
      if (acc >= pressureTokens) break;
    }
    windowEntries = entries.slice(start);
    windowTokens = acc;
  }

  const buckets = new Map();
  for (const key of GROUP_ORDER) buckets.set(key, { key, label: GROUP_LABELS[key], tokens: 0, count: 0 });

  for (const entry of windowEntries) {
    const bucket = buckets.get(entry.key) ?? buckets.get("other");
    bucket.tokens += entry.tokens;
    bucket.count += 1;
  }

  const groups = [...buckets.values()]
    .filter((group) => group.count > 0)
    .sort((a, b) => GROUP_ORDER.indexOf(a.key) - GROUP_ORDER.indexOf(b.key));

  return {
    ok: true,
    sessionId: session.header?.id ?? null,
    total: Number(measurement.totalTokens ?? 0),
    logTokens,
    windowTokens,
    baseline: measurement.baseline ?? null,
    surface: Number(measurement.surfaceTokens ?? 0),
    nodes: (measurement.nodes ?? []).length,
    groups,
    pressure: pressure
      ? {
          contextWindow: pressure.contextWindow ?? null,
          pressureTokens: pressure.pressureTokens ?? null,
          projectedTokens: pressure.projectedTokens ?? null,
        }
      : null,
  };
}

function formatCount(tokens) {
  const value = Math.max(0, Math.round(Number(tokens) || 0));
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

/**
 * 生成压缩提示词。
 * 设计意图：让模型「摘要 + 从此以摘要为准」，而不是指望它真去改历史消息——
 * 会话日志是 append-only 的，硬改会破坏 surface 一致性。
 */
export function buildCompressionPrompt({ groups = [], note = "", modeName = "" } = {}) {
  const list = (Array.isArray(groups) ? groups : [])
    .filter((group) => group && (group.label || group.key))
    .map((group) => {
      const label = String(group.label ?? group.key ?? "模块");
      const tokens = Number(group.tokens ?? 0);
      const count = Number(group.count ?? 0);
      const detail = count > 0 ? `≈${formatCount(tokens)} tokens（${count} 条）` : `≈${formatCount(tokens)} tokens`;
      return `- ${label}：${detail}`;
    });

  const lines = [
    "---",
    "",
    "【上下文管控 · 独立指令】下面这段不是待办清单的一项，也不是对上面那条消息的补充说明。",
    "请先执行这条指令，做完再回到原来的任务。",
    "",
    "## 现在要做的事",
    "如果本会话有折叠/压缩类工具（例如 compress），就用它把下面这些模块折叠成摘要：一次调用里把所有要压缩的连续区段一起传进去，summary 由你写。",
    "没有这类工具时，直接在回复里给出各模块的压缩摘要，并说明工具不可用。",
    "",
    "## 需要压缩的模块",
    ...(list.length > 0 ? list : ["- （未勾选具体模块，请按下面要求压缩最占地方的部分）"]),
    "",
    "## 压缩要求",
    "1. 每个模块单独一节，标题写成 `## 压缩摘要 · <模块名>`；只保留结论、关键数据、文件路径与行号、未完成的待办与风险。",
    "2. 丢掉重复输出、完整日志、成功回执、大段源码、已确认无用的大文件内容；单个模块控制在原文的 15% 以内。",
    "3. 用条目式，不写过渡语，不复述用户原始需求。",
    "4. 压缩完成后，后续回复以摘要为准；再读同一文件或重跑同一命令前先查摘要，避免重复占用上下文。",
    "5. 某个模块确实无法压缩（例如只含用户原始需求、或必须逐字保留），单独标注「保留」并说明原因。",
  ];

  if (typeof note === "string" && note.trim()) {
    lines.push("", "## 额外要求", note.trim().slice(0, 2000));
  }

  return lines.join("\n");
}

/** 把压缩提示词投递进会话（queue 模式：不打断正在跑的回合）。 */
export async function injectCompressionPrompt(ctx, { sessionId, groups, note, modeName, mode } = {}) {
  const id = String(sessionId ?? "").trim();
  if (!id) throw new Error("缺少 sessionId");
  const controller = getService(ctx, "sessionController");
  if (!controller || typeof controller.prompt !== "function") {
    throw new Error("sessionController 不可用，无法注入提示词");
  }

  const text = buildCompressionPrompt({ groups, note, modeName });
  const request = {
    requestId: randomUUID(),
    sessionId: id,
    mode: mode === "queue" ? "queue" : "steer",
    content: [{ type: "text", text }],
  };

  const abort = new AbortController();
  await controller.prompt(request, abort.signal);
  return { ok: true, text, requestId: request.requestId };
}
