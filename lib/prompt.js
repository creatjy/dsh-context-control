/**
 * 组装结果的读取、描述与裁剪。
 *
 * 关键事实（决定了为什么这么做）：
 *   - `system-prompt/assemble` 是 waterfall，监听器拿到 (assembly, context, next)，
 *     `await next()` 之后拿到的就是**最终**要发出去的文本；在这里删段/改段有效。
 *   - `context.agent` 就是这个请求所属的会话（agent.id 即 SessionId），
 *     所以同一份装配结果可以按会话记下来，左栏页面据此显示「这个会话实际会发什么」。
 *   - 工具定义在 `assembled.tools` 里，可以照 dsh-remote 的写法一并过滤；
 *     另外宿主侧还会用 `tools.restrict` 做兜底（见 index.js）。
 */
import { estimateTokens, previewOf } from "./tokens.js";

/** 段落归组：界面上的「系统内容 / 技能 / 注入 / 工具说明」。 */
export function groupOfSection(name) {
  const value = String(name ?? "").toLowerCase();
  if (/skill|capabilit/.test(value)) return "skills";
  if (/tool|mcp|toolbox/.test(value)) return "tools";
  if (/memor|hindsight|inject|context|recall|knowledge/.test(value)) return "inject";
  return "system";
}

export function groupOfContext(name) {
  const value = String(name ?? "").toLowerCase();
  if (/memor|hindsight|recall|knowledge/.test(value)) return "inject";
  return "contexts";
}

export const GROUP_LABELS = {
  system: "系统内容",
  skills: "技能",
  tools: "工具",
  inject: "注入",
  contexts: "运行时注入",
  conversation: "会话上下文",
};

/** 工具定义的 token 体量：名字 + 描述 + 参数 schema 一起算，这才是真正发出去的东西。 */
export function toolTokens(tool) {
  return estimateTokens(
    JSON.stringify({
      name: tool?.name ?? "",
      description: tool?.description ?? "",
      parameters: tool?.parameters ?? {},
    }),
  );
}

/** 把一次装配结果整理成界面数据结构（不裁剪，保留原文供编辑）。 */
export function describeAssembly(assembled) {
  const sections = (assembled?.sections ?? []).map((section) => {
    const text = typeof section.text === "string" ? section.text : "";
    return {
      name: String(section.name ?? ""),
      text,
      tokens: estimateTokens(text),
      preview: previewOf(text),
      group: groupOfSection(section.name),
    };
  });

  const contexts = (assembled?.contexts ?? []).map((context) => {
    const text = typeof context.text === "string" ? context.text : "";
    return {
      name: String(context.name ?? ""),
      text,
      tokens: estimateTokens(text),
      preview: previewOf(text),
      group: groupOfContext(context.name),
    };
  });

  const tools = (assembled?.tools ?? []).map((tool) => ({
    name: String(tool?.name ?? ""),
    description: String(tool?.description ?? ""),
    // 宿主既然给了 tokens 就用它：只按 schema 重算会漏掉工具说明里的长文本。
    tokens: Number(tool?.tokens) > 0 ? Number(tool.tokens) : toolTokens(tool),
    group: "tools",
  }));

  const total =
    sections.reduce((sum, item) => sum + item.tokens, 0) +
    contexts.reduce((sum, item) => sum + item.tokens, 0) +
    tools.reduce((sum, item) => sum + item.tokens, 0);

  return { at: Date.now(), sections, contexts, tools, total };
}

/**
 * 按规则表裁剪一份装配结果。
 * 返回新的对象（不原地改），并带回被摘掉的模块名，方便界面/日志核对。
 */
export function applyRules(assembled, rules) {
  const sectionRules = rules?.sections ?? {};
  const contextRules = rules?.contexts ?? {};
  const toolRules = rules?.tools ?? {};

  const removed = { sections: [], contexts: [], tools: [] };
  const edited = { sections: [], contexts: [] };

  const sections = [];
  for (const section of assembled?.sections ?? []) {
    const rule = sectionRules[section.name];
    if (rule?.enabled === false) {
      removed.sections.push(section.name);
      continue;
    }
    if (typeof rule?.text === "string") {
      edited.sections.push(section.name);
      sections.push({ ...section, text: rule.text });
      continue;
    }
    sections.push(section);
  }

  const contexts = [];
  for (const context of assembled?.contexts ?? []) {
    const rule = contextRules[context.name];
    if (rule?.enabled === false) {
      removed.contexts.push(context.name);
      continue;
    }
    if (typeof rule?.text === "string") {
      edited.contexts.push(context.name);
      contexts.push({ ...context, text: rule.text });
      continue;
    }
    contexts.push(context);
  }

  const tools = [];
  for (const tool of assembled?.tools ?? []) {
    const rule = toolRules[tool?.name];
    if (rule?.enabled === false) {
      removed.tools.push(tool.name);
      continue;
    }
    tools.push(tool);
  }

  return { assembly: { ...assembled, sections, contexts, tools }, removed, edited };
}

/** 规则表是否「什么都没改」——是的话直接把原样返回，省掉一次重建。 */
export function rulesAreNoop(rules) {
  for (const kind of ["sections", "contexts", "tools"]) {
    if (Object.keys(rules?.[kind] ?? {}).length > 0) return false;
  }
  return true;
}

/**
 * 最近几次装配的快照：会话 -> 数据结构。
 * 只留最新的一份，按时间淘汰，避免长期占内存。
 */
export class SnapshotMemory {
  constructor(limit = 24) {
    this.limit = limit;
    this.byAgent = new Map();
    this.global = null;
  }

  remember(agentId, described) {
    const entry = { ...described, agentId: agentId ?? null };
    if (!agentId) {
      this.global = entry;
      return entry;
    }
    this.byAgent.delete(agentId);
    this.byAgent.set(agentId, entry);
    while (this.byAgent.size > this.limit) {
      const oldest = this.byAgent.keys().next().value;
      if (oldest === undefined) break;
      this.byAgent.delete(oldest);
    }
    return entry;
  }

  get(agentId) {
    if (!agentId) return null;
    return this.byAgent.get(agentId) ?? null;
  }

  latest() {
    let winner = this.global;
    for (const entry of this.byAgent.values()) {
      if (!winner || entry.at > winner.at) winner = entry;
    }
    return winner;
  }

  sessions() {
    return [...this.byAgent.values()]
      .sort((a, b) => b.at - a.at)
      .map((entry) => ({ id: entry.agentId, at: entry.at, total: entry.total }));
  }
}
