/**
 * dsh-context-control —— 宿主侧。
 *
 * 做的事：
 *   1. 存「模式」：每个模式是一份模块规则表（开关 / 改写文本）。
 *   2. 在 `system-prompt/assemble` waterfall 里按当前模式的规则摘段、改段。
 *   3. 用 `tools.restrict` 把被关掉的工具真正从工具表里摘掉（兜底强化）。
 *   4. 起一个 HTTP 接口给浏览器半（左栏页面 + 会话内入口）读写状态。
 *   5. 提供「注入压缩提示词」：把勾选的模块清单写成提示词投递进会话。
 *
 * 为什么内容过滤放在 assemble、不放 llm/stream：
 *   loop 构造的请求对象是深冻结的，且要求「内容必须是会话日志的纯函数」，
 *   在 llm/stream 里改消息会直接抛错；而 assemble 返回的文本才是权威的。
 */
import { readFileSync } from "node:fs";
import { ModeStore, normalizeCapValue, ruleStats } from "./store.js";
import { estimateTokens, previewOf } from "./tokens.js";
import {
  SnapshotMemory,
  applyRules,
  describeAssembly,
  rulesAreNoop,
  toolTokens,
} from "./prompt.js";
import {
  buildCompressionPrompt,
  getService,
  injectCompressionPrompt,
  resolveAgent,
  sessionBreakdown,
} from "./session.js";
import {
  applyCaps,
  buildBrief,
  buildCatalog,
  capMode,
  capPlan,
  discoverDiskSkills,
  filterSkillLines,
  isSkillSection,
  mcpServerOfTool,
  pluginLabel,
  pluginOfTool,
} from "./capabilities.js";
import { createAiService, resolveRoute } from "./ai/service.js";

export const name = "context-control";
export const inject = ["systemPrompt", "tools", "webServer"];

const PACKAGE_URL = new URL("../package.json", import.meta.url);

/**
 * 每次调用都读盘：插件热重载会复用已求值的模块，模块级常量会把版本号钉在旧值上。
 * 读盘很便宜（几 KB，一次 API 请求只读一次），换来「改完 package.json 立刻显示」。
 */
function pluginVersion() {
  try {
    return JSON.parse(readFileSync(PACKAGE_URL, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const API_PATH = "/dsh-context-control/api";
const BODY_LIMIT = 4 * 1024 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${err?.message ?? err}`));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  try {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  } catch {
    try {
      response.end("{}");
    } catch {
      /* 连接已经断了 */
    }
  }
}

/**
 * 一份规则里，「工具定义」和它的说明段是两条记录（`tools.pty` 与 `sections["tool:pty"]`），
 * 但它们对用户是同一个东西：关掉工具就不该还留着它的说明。这里把两边对齐，
 * 任一边写成 false 都视为整体关闭。
 */
function effectiveRules(store) {
  const raw = store.activeRules() ?? {};
  const sections = { ...(raw.sections ?? {}) };
  const tools = { ...(raw.tools ?? {}) };
  for (const [name, rule] of Object.entries(raw.tools ?? {})) {
    if (rule?.enabled !== false) continue;
    const key = `tool:${name}`;
    if (!sections[key]) sections[key] = { enabled: false };
  }
  for (const [key, rule] of Object.entries(raw.sections ?? {})) {
    if (!key.startsWith("tool:") || rule?.enabled !== false) continue;
    const name = key.slice(5);
    if (!tools[name]) tools[name] = { enabled: false };
  }
  return { ...raw, sections, tools };
}

/** 当前模式下被关掉的工具名。 */
function denyTools(store) {
  const rules = effectiveRules(store).tools ?? {};
  return Object.keys(rules).filter((name) => rules[name]?.enabled === false);
}

/**
 * 当前真实注册的全局工具名。
 *
 * `runtime.toolCatalog` 是「只增不减」的界面目录：插件被删掉后，旧工具名
 * 还要留在面板里让用户看到并撤销规则。但 `tools.restrict()` 对不存在的名字
 * 会整条抛错，所以限制前必须用这份实时表过滤，不能用界面目录。
 */
function liveToolNames(runtime) {
  try {
    const fresh = getService(runtime.ctx, "tools")?.schemas?.();
    if (!Array.isArray(fresh)) return null;
    return new Set(fresh.map((tool) => tool?.name).filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * 工具「是否加载」的落地。
 *
 * `tools.restrict()` 只接受 scoped context（agent.ctx）：全局限制会把每个 agent 都盖住，
 * 框架因此直接抛错。所以只能在装配时拿到 `context.agent` 后，按 agent 各挂一份限制，
 * 并用 deny 列表当 key 缓存——不变就不重复挂，变了就先撤旧的再挂新的。
 */
function syncAgentRestriction(runtime, agent, capDeny = []) {
  if (!agent || !agent.id) return;
  const map = runtime.agentRestrictions ?? (runtime.agentRestrictions = new Map());
  // 两路来源：当前模式里被关掉的工具，加上当前项目里被关掉的能力所带的工具。
  const deny = [...new Set([...denyTools(runtime.store), ...capDeny])];
  const key = deny.slice().sort().join("|");
  const prev = map.get(agent.id);
  if (prev && prev.key === key) return;

  if (prev) {
    try {
      prev.dispose?.();
    } catch {
      /* 已经失效 */
    }
    map.delete(agent.id);
  }
  if (deny.length === 0) {
    runtime.lastError = "";
    return;
  }

  // restrict 对未知名字会整条抛错，所以先跟真实工具表对齐一次。
  // 优先用实时工具表；界面目录会保留已删除插件的旧名字，不能用来校验。
  const known = liveToolNames(runtime) ?? runtime.toolCatalog;
  const safe = known ? deny.filter((name) => known.has(name)) : deny;
  const unknown = deny.length - safe.length;
  if (safe.length === 0) {
    runtime.lastError = "";
    runtime.skippedTools = unknown;
    return;
  }

  const scoped = (agent.ctx && agent.ctx.tools) || agent.tools;
  if (!scoped || typeof scoped.restrict !== "function") {
    runtime.lastError = "这个版本的 agent 没有提供 scoped tools，工具开关这次只影响说明段。";
    return;
  }
  try {
    const dispose = scoped.restrict({ deny: safe });
    if (typeof dispose === "function") {
      map.set(agent.id, { key, dispose });
      runtime.skippedTools = unknown;
      runtime.lastError = "";
    }
  } catch (err) {
    runtime.lastError = `工具限制失败：${err?.message ?? err}`;
  }
}

/** 规则改了：撤掉所有已挂的限制，下一次装配按新规则重挂。 */
function invalidateRuntime(runtime) {
  // 配置一变，上一轮「实测装配」与能力目录就过期了：不清掉的话，界面会拿旧数字冒充新结果
  // （例如刚把能力打开，简介预览里还挂着它）。
  runtime.catalogCache?.clear();
  runtime.effectiveByAgent?.clear();
  runtime.capDiag = null;
  resetRestrictions(runtime);
}

function resetRestrictions(runtime) {
  const map = runtime.agentRestrictions;
  if (!map) return;
  for (const entry of map.values()) {
    try {
      entry.dispose?.();
    } catch {
      /* 已经失效 */
    }
  }
  map.clear();
}

/**
 * 工具定义不在装配结果里（0.2.x 由 provider 自己握着），所以从 tools.schemas() 取。
 * 只增不减：被 restrict 摘掉的工具会从 schemas() 里消失，但界面必须还能把它打开，
 * 所以第一次拿到就记进 catalog，之后只更新不删除。
 */
function catalogTools(runtime) {
  const catalog = runtime.toolCatalog ?? (runtime.toolCatalog = new Map());
  let fresh = [];
  try {
    fresh = getService(runtime.ctx, "tools")?.schemas?.() ?? [];
  } catch (err) {
    runtime.lastError = `工具表读取失败：${err?.message ?? err}`;
  }
  for (const tool of fresh) {
    const name = tool?.name;
    if (!name) continue;
    const description = String(tool?.description ?? "");
    catalog.set(name, {
      name,
      group: "tools",
      capKey: capKeyOfTool(name),
      tokens: toolTokens(tool),
      preview: previewOf(description, 120),
      description,
    });
  }
  return [...catalog.values()].sort((a, b) => b.tokens - a.tokens);
}

/** 装配结果里没有工具时补上真实工具清单，并重算总量。 */
function attachTools(runtime, prompt) {
  if (prompt?.tools?.length) return prompt;
  const tools = catalogTools(runtime);
  if (tools.length === 0) return prompt;
  const sum = (list) => list.reduce((n, item) => n + (item?.tokens ?? 0), 0);
  return {
    ...prompt,
    tools,
    toolsFrom: "schemas",
    total: sum(prompt.sections ?? []) + sum(prompt.contexts ?? []) + sum(tools),
  };
}

/**
 * 能力目录（技能 / MCP / 插件）缓存。
 *
 * 目录是从「过滤前」的装配快照里读的——快照记的是完整内容，
 * 所以关掉一项之后仍然能在界面里把它打开。
 * 30 秒过期一次：装了新插件、改了工具表，最多半分钟后界面跟上。
 */
const CATALOG_TTL = 30_000;

function capabilityCatalog(runtime, agentId, cwd) {
  const cache = runtime.catalogCache ?? (runtime.catalogCache = new Map());
  const key = `${agentId ?? ""}|${cwd ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL) return hit.catalog;

  const snapshot = (agentId ? runtime.snapshots.get(agentId) : null) ?? runtime.snapshots.latest();
  const catalog = buildCatalog({
    sections: snapshot?.sections ?? [],
    tools: catalogTools(runtime),
    diskSkills: discoverDiskSkills(cwd),
  });
  cache.set(key, { at: Date.now(), catalog });
  if (cache.size > 16) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return catalog;
}

const WORKSPACE_SYNC_TTL = 10_000;
// 自动压缩阈值的兜底值：默认 0.8，可在面板里改成 0.3–0.95（存在 modes.json 的 autoCompact）。
const AUTO_COMPACT_RATIO = 0.8;

/** 面板里配的自动压缩开关/阈值；读不到就退回默认。 */
function autoCompactSettings(runtime) {
  try {
    const settings = runtime.store?.autoCompact?.();
    if (settings && typeof settings === "object") {
      return {
        enabled: settings.enabled !== false,
        ratio: Number.isFinite(Number(settings.ratio)) ? Number(settings.ratio) : AUTO_COMPACT_RATIO,
      };
    }
  } catch {
    /* 配置读失败按默认走 */
  }
  return { enabled: true, ratio: AUTO_COMPACT_RATIO };
}

function autoCompactRatio(runtime) {
  return autoCompactSettings(runtime).ratio;
}

/** 记一次压缩结果：内存里给界面看，modes.json 里给重载后的界面看。 */
function rememberCompact(runtime, record) {
  runtime.lastCompact = record;
  try {
    runtime.store?.setLastCompact?.(record);
  } catch {
    /* 落盘失败不影响这次结果 */
  }
  return record;
}

/**
 * 把 DSH 已注册的工作区同步进项目表：面板打开就能看到全部工作区，不用手动新增。
 * 10 秒一次就够（注册表变化很慢），失败静默——工作区服务没起来时只是少几个项目。
 */
function syncWorkspaces(runtime) {
  const now = Date.now();
  if (now - (runtime.workspaceSyncAt ?? 0) < WORKSPACE_SYNC_TTL) return runtime.workspaceSync || [];
  runtime.workspaceSyncAt = now;
  let list = [];
  try {
    const registry = getService(runtime.ctx, "workspaceRegistry");
    const workspaces = registry?.list ? registry.list() : [];
    list = (workspaces ?? []).map((workspace) => ({
      id: String(workspace?.id ?? ""),
      name: String(workspace?.title ?? ""),
      path: String(workspace?.path ?? ""),
    }));
    runtime.store.syncWorkspaces(list, { authoritative: true });
    runtime.workspaceSync = list;
  } catch (error) {
    runtime.workspaceSync = runtime.workspaceSync || [];
    runtime.workspaceSyncError = error?.message ?? String(error);
    list = runtime.workspaceSync;
  }
  return list;
}

/** 会话级「已唤醒」集合：简介项被真调用一次，本会话内就按「加载」处理。 */
function awakeSet(runtime, sessionId) {
  if (!sessionId) return null;
  const map = runtime.awake ?? (runtime.awake = new Map());
  return map.get(String(sessionId)) ?? null;
}

function wakeCap(runtime, sessionId, key) {
  if (!sessionId || !key) return false;
  const map = runtime.awake ?? (runtime.awake = new Map());
  const id = String(sessionId);
  const set = map.get(id) ?? new Set();
  const changed = !set.has(key);
  set.add(key);
  map.set(id, set);
  if (map.size > 64) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined && oldest !== id) map.delete(oldest);
  }
  // 唤醒后 deny 列表变了，旧限制要撤掉，否则工具还是调不到。
  if (changed) resetRestrictions(runtime);
  return changed;
}

/** 工具名 → 它属于哪个能力（插件 / MCP）。查不到返回 null。 */
function capKeyOfTool(toolName) {
  if (!toolName) return null;
  const server = mcpServerOfTool(toolName);
  if (server) return `mcp:${server}`;
  const plugin = pluginOfTool(toolName);
  return plugin ? `plugin:${plugin}` : null;
}

/** 能力 key 的中文说法，用在审批弹窗与提示里。 */
function capLabelOf(key) {
  const text = String(key ?? "");
  const cut = text.indexOf(":");
  const kind = cut >= 0 ? text.slice(0, cut) : text;
  const id = cut >= 0 ? text.slice(cut + 1) : "";
  if (kind === "skill") return `技能 ${id}`;
  if (kind === "mcp") return `MCP ${id}`;
  if (kind === "plugin") return `插件 ${pluginLabel(id)}`;
  return text;
}

/** 当前请求属于哪个项目：会话 cwd 决定，匹配不上就是「工作区默认」。 */
function capabilityContext(runtime, agent) {
  syncWorkspaces(runtime);
  const cwd = String(agent?.session?.header?.cwd ?? "");
  const project = runtime.store.projectForCwd(cwd);
  // 先项目（含继承），再叠会话级覆盖——胶囊里改的档位只影响这一条会话。
  const caps = {
    ...runtime.store.capsFor(project.id),
    ...runtime.store.sessionCaps(agent?.id),
  };
  // 唤醒态只在内存里、不落盘：换一个会话重新从项目配置算起。
  const awake = awakeSet(runtime, agent?.id);
  if (awake) for (const key of awake) caps[key] = true;
  const catalog = capabilityCatalog(runtime, agent?.id ?? null, cwd);
  // 全局层 + 继承链 + 项目自己的段落/工具规则，最后叠会话覆盖，越靠后越强。
  const layers = runtime.store.layersForSession(project?.id ?? "", agent?.id);
  return { cwd, project, caps, catalog, layers, plan: capPlan(catalog, caps) };
}

/**
 * 解析能力上下文，并立刻把「本会话不该用的工具」挂到 agent 上。
 *
 * 装配 waterfall 里做太晚：宿主在 systemPrompt.assemble 之前就已经
 * tools.resolve() 过了，所以首轮第一次请求会漏掉限制。agent/created 在
 * 第一次模型步骤之前触发，在这里挂限制才能覆盖第一步。
 */
function bindCapabilityRestriction(runtime, agent) {
  const caps = capabilityContext(runtime, agent);
  runtime.capDiag = {
    at: Date.now(),
    cwd: caps.cwd,
    projectId: caps.project?.id ?? null,
    projectName: caps.project?.name ?? "",
    disabled: caps.plan.items.length,
    disabledSections: caps.plan.sections.size,
    disabledTools: caps.plan.tools.size,
    disabledSkills: caps.plan.skills.size,
  };
  const scopeDisabledTools = Object.entries(caps.layers?.tools ?? {})
    .filter(([, rule]) => rule?.enabled === false)
    .map(([name]) => name);
  syncAgentRestriction(runtime, agent, [...new Set([...caps.plan.tools, ...scopeDisabledTools])]);
  return caps;
}

/** 把一个会话的 cwd 拿出来（界面按项目显示能力时用）。 */
async function sessionCwd(runtime, sessionId) {
  if (!sessionId) return "";
  try {
    const agent = await resolveAgent(runtime.ctx, sessionId);
    return String(agent?.session?.header?.cwd ?? "");
  } catch {
    return "";
  }
}

/** 把「能力被关掉」翻译成规则，跟模式里手写的规则合到一起。 */
function mergeCapRules(rules, plan) {
  // 完全隐藏的能力不进简介（items 为空），但它的段和工具仍然要裁剪。
  if (plan.items.length === 0 && plan.sections.size === 0 && plan.tools.size === 0) return rules;
  const sections = { ...(rules.sections ?? {}) };
  const tools = { ...(rules.tools ?? {}) };
  for (const name of plan.sections) {
    if (!sections[name]) sections[name] = { enabled: false };
  }
  for (const name of plan.tools) {
    if (!tools[name]) tools[name] = { enabled: false };
  }
  return { ...rules, sections, tools };
}

/**
 * 项目 / 全局层的段落与工具规则，盖在模式规则之上（后写的赢）。
 * 与模式规则同构，所以能直接喂给 applyRules。
 */
function mergeScopeRules(rules, layers) {
  if (!layers) return rules;
  const sections = { ...(rules.sections ?? {}) };
  const tools = { ...(rules.tools ?? {}) };
  for (const [name, rule] of Object.entries(layers.sections ?? {})) {
    sections[name] = { ...(sections[name] ?? {}), ...rule };
  }
  for (const [name, rule] of Object.entries(layers.tools ?? {})) {
    tools[name] = { ...(tools[name] ?? {}), ...rule };
  }
  return { ...rules, sections, tools };
}

/** 项目 / 全局层关掉的段落，也进简介；文本按当前装配估。 */
function scopeBriefItems(caps, assembled) {
  const items = [];
  if (!caps?.layers) return items;
  const byName = new Map((assembled.sections ?? []).map((section) => [section.name, section]));
  for (const [name, rule] of Object.entries(caps.layers.sections ?? {})) {
    if (rule?.enabled !== false) continue;
    const section = byName.get(name);
    items.push({
      label: name,
      detail: section ? previewOf(section.text, 60) : "系统提示段",
      tokens: section ? estimateTokens(section.text) : 0,
    });
  }
  return items;
}

/** 关掉的技能：从目录段里删行（技能没有独立段落，只有那一行摘要）。 */
function filterSkillSections(sections, disabled) {
  if (!disabled || disabled.size === 0) return sections;
  return sections.map((section) => {
    if (!isSkillSection(section)) return section;
    const { text, removed } = filterSkillLines(section.text, disabled);
    return removed > 0 ? { ...section, text } : section;
  });
}

/**
 * 模式里手动关掉的段落 / 上下文 / 工具，也要进简介。
 * 能力开关导致的关掉已经由 capPlan 收了，这里跳过它们，避免一条写两遍。
 */
function modeBriefItems(runtime, assembled, plan) {
  const rules = effectiveRules(runtime.store);
  const seen = new Set([
    ...[...plan.sections].map((name) => `s:${name}`),
    ...[...plan.tools].map((name) => `t:${name}`),
  ]);
  const items = [];

  for (const section of assembled?.sections ?? []) {
    if (rules.sections?.[section.name]?.enabled !== false) continue;
    if (seen.has(`s:${section.name}`)) continue;
    const text = String(section.text ?? "");
    items.push({
      kind: "sections",
      label: `系统段落 ${section.name}`,
      detail: previewOf(text, 70),
      tokens: estimateTokens(text),
    });
  }
  for (const context of assembled?.contexts ?? []) {
    if (rules.contexts?.[context.name]?.enabled !== false) continue;
    if (seen.has(`s:${context.name}`)) continue;
    const text = String(context.text ?? "");
    items.push({
      kind: "contexts",
      label: `运行时上下文 ${context.name}`,
      detail: previewOf(text, 70),
      tokens: estimateTokens(text),
    });
  }
  for (const tool of runtime.toolCatalog?.values() ?? []) {
    if (rules.tools?.[tool.name]?.enabled !== false) continue;
    if (seen.has(`t:${tool.name}`)) continue;
    items.push({ kind: "tools", label: `工具 ${tool.name}`, detail: tool.preview, tokens: tool.tokens });
  }
  return items;
}

/** 把「关闭项简介」接到系统提示末尾：关掉 ≠ 消失。 */
function withBrief(assembly, items) {
  if (!items || items.length === 0) return assembly;
  const total = items.reduce((sum, item) => sum + (item.tokens ?? 0), 0);
  const text = buildBrief(items, { totalTokens: total });
  if (!text) return assembly;
  return {
    ...assembly,
    sections: [...(assembly.sections ?? []), { name: "context-control:brief", text }],
  };
}

/** 优先用「这个会话刚才真实装配过的结果」，没有就现场探一次装配。 */
async function promptFor(runtime, sessionId) {
  const snapshot = runtime.snapshots.get(sessionId) ?? runtime.snapshots.latest();
  if (snapshot) return { ...snapshot, source: "snapshot" };

  try {
    const assembled = await runtime.ctx.systemPrompt.assemble({ __ccProbe: true });
    return { ...describeAssembly(assembled), agentId: null, source: "live" };
  } catch (err) {
    return {
      at: Date.now(),
      sections: [],
      contexts: [],
      tools: [],
      total: 0,
      source: "unavailable",
      error: String(err?.message ?? err),
    };
  }
}

function briefPreview(runtime, sessionId) {
  const map = runtime.effectiveByAgent;
  if (!map || map.size === 0) return "";
  const found = new Map();
  for (const [id, snap] of map) {
    for (const section of snap?.sections ?? []) {
      if (section?.name === "context-control:brief") found.set(id, String(section.text ?? ""));
    }
  }
  if (found.size === 0) return "";
  return (sessionId ? found.get(sessionId) : null) ?? [...found.values()].at(-1) ?? "";
}

async function compactionStatus(runtime, agent, sessionId) {
  if (!agent && sessionId) {
    try { agent = await resolveAgent(runtime.ctx, sessionId); } catch {}
  }
  const direct = (agent && agent.ctx ? getService(agent.ctx, "compaction") : undefined) ?? getService(runtime.ctx, "compaction");
  if (direct && typeof direct.compactNow === "function") return { available: true, via: "service", reason: "" };
  // 这个 profile 的 compaction 实例挂在 agent preset 作用域里，宿主平面上看不到。
  const presets = getService(runtime.ctx, "agentPresets");
  if (presets && typeof presets.serviceFor === "function" && agent) {
    try {
      const scoped = presets.serviceFor(agent, "compaction");
      if (scoped && typeof scoped.compactNow === "function") return { available: true, via: "preset", reason: "" };
    } catch {
      /* 没有 preset 实例就继续往下探命令 */
    }
  }
  const commands = getService(runtime.ctx, "commands");
  if (commands && typeof commands.list === "function") {
    try {
      const names = commands.list(agent).map((item) => item && item.name).filter(Boolean);
      if (names.includes("compact")) return { available: true, via: "command", reason: "" };
    } catch {}
  }
  // 面板打开时不一定带 sessionId；只要这次运行里真的拿到过实例，就说明压缩可用。
  if (runtime.compactionSeen) return { available: true, via: "seen", reason: "" };
  return {
    available: false,
    via: null,
    reason: "宿主没有暴露压缩服务，也没有注册 /compact 命令（常见于宿主插件接管了压缩，或压缩插件未启用；这类改动通常要重启应用才生效）。按钮会改发一条 steer 指令，让模型就地折叠你勾选的模块。",
  };
}

/**
 * 真正跑一次宿主压缩。宿主只允许「空闲 agent」压缩（报错原文：
 * manual compaction requires an idle agent with no waking queued work），
 * 所以我们既在看板上直接压，也会在 turn/end 之后补压——见下面的排队逻辑。
 */
async function compactSession(runtime, sessionId, why = "manual") {
  const agent = await resolveAgent(runtime.ctx, String(sessionId ?? ""));
  if (!agent?.session) throw new Error("找不到该会话的 agent（先在对话里发一条消息）");
  const meter = getService(runtime.ctx, "tokenMeter");
  const before = meter?.measure ? meter.measure(agent.session) : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  const compaction = resolveCompaction(runtime, agent);
  let result = null;
  let via = "service";
  let note = "";
  const failures = [];
  try {
    // 宿主 compactNow 内部会调 agent.runMaintenance(...)——传合成对象会被 catch 成
    // "manual compaction requires an idle agent with no waking queued work"（假 busy）。
    if (compaction && typeof compaction.compactNow === "function" && typeof agent.runMaintenance === "function") {
      try {
        result = await compaction.compactNow(agent, controller.signal);
        via = "agent";
      } catch (error) {
        failures.push(`service: ${error?.message ?? error}${error?.cause?.message ? ` / cause: ${error.cause.message}` : ""}`);
        if (/abort/i.test(String(error?.name ?? error?.message ?? ""))) throw error;
      }
    } else if (compaction && typeof compaction.compactNow === "function") {
      failures.push(`service: agent 上没有 runMaintenance（keys=${Object.keys(agent).slice(0, 12).join(",")}）`);
    }
    if (result === null || result === undefined) {
      // 服务路径没成（或确实没有可压缩区间）：借 /compact 命令的闭包执行同一件事，它传的是真 agent。
      const commands = getService(runtime.ctx, "commands");
      if (commands?.execute) {
        via = "command";
        try {
          const execution = await commands.execute(agent, "/compact", [], controller.signal);
          if (!execution) throw new Error("命令注册表里没有 /compact 可用");
          note = String(execution.result?.text ?? "");
          if (execution.result?.kind === "error") throw new Error(note || "压缩失败");
          // 命令对「没什么可压」也返回 success（"No compactable history yet."），别当成真压过。
          if (/no compactable/i.test(note)) result = null;
          else result = { summarySeq: execution.result?.sourceEventSeq ?? null };
        } catch (error) {
          failures.push(`command: ${error?.message ?? error}`);
        }
      }
    }
    if (result === null || result === undefined) {
      if (failures.length) throw new Error(failures.join("；"));
      note = "没有可压缩的区间（宿主认为当前历史已经够短）";
    }
  } finally {
    clearTimeout(timer);
  }
  const after = meter?.measure ? meter.measure(agent.session) : null;
  invalidateRuntime(runtime);
  return {
    sessionId,
    why,
    via,
    note,
    compacted: result !== null,
    summarySeq: result?.summarySeq ?? null,
    shadowedTokens: result?.shadowedTokenCount ?? 0,
    beforeTokens: before?.totalTokens ?? null,
    afterTokens: after?.totalTokens ?? null,
    beforeSurface: before?.surfaceTokens ?? null,
    afterSurface: after?.surfaceTokens ?? null,
  };
}

/**
 * 按当前规则模拟一次装配：只算 token，不碰运行时状态。
 * 用来让「概览」和「提示段 / 工具」页显示下一轮真正会发多少，而不是原始装配。
 */
function projectRequest(runtime, prompt, plan, layers) {
  const rules = mergeScopeRules(mergeCapRules(effectiveRules(runtime.store), plan), layers);
  let next = prompt;
  let removed = { sections: [], contexts: [], tools: [] };
  if (!rulesAreNoop(rules)) {
    const result = applyRules(next, rules);
    next = result.assembly;
    removed = result.removed;
  }
  next = { ...next, sections: filterSkillSections(next.sections ?? [], plan.skills) };
  if (runtime.store.briefEnabled()) {
    next = withBrief(next, [
      ...plan.items,
      ...scopeBriefItems({ layers }, prompt),
      ...modeBriefItems(runtime, prompt, plan),
    ]);
  }
  const removedNames = {
    sections: new Set(removed.sections),
    contexts: new Set(removed.contexts),
    tools: new Set(removed.tools),
  };
  const tokensOf = (list, names) => (list ?? []).reduce((sum, item) => sum + (names.has(item?.name) ? item?.tokens ?? 0 : 0), 0);
  const removedTokens =
    tokensOf(prompt.sections, removedNames.sections) +
    tokensOf(prompt.contexts, removedNames.contexts) +
    tokensOf(prompt.tools, removedNames.tools);
  return { ...describeAssembly(next), removed, removedTokens };
}


/**
 * AI 建议的证据收集：只读，不做任何写入。
 * scope 决定「写哪一层」；item 只分析单条，写它的父层。
 */
async function collectAiEvidence(runtime, body = {}) {
  const store = runtime.store;
  const sessionId = String(body.sessionId ?? "");
  let agent = null;
  try {
    if (sessionId) agent = await resolveAgent(runtime.ctx, sessionId);
  } catch {
    agent = null;
  }
  const prompt = attachTools(runtime, await promptFor(runtime, sessionId));
  const cwd = await sessionCwd(runtime, sessionId);
  const project = store.projectForCwd(cwd);
  const catalog = capabilityCatalog(runtime, sessionId || null, cwd);
  const layers = store.layersForSession(project.id, sessionId);
  const active = store.active();
  const wantScope = String(body.scope ?? "global");

  const globalRules = store.scopeRules("global");
  const projectRules = store.scopeRules(project.id);
  const sessionRules = sessionId ? store.sessionRules(sessionId) : { sections: {}, tools: {} };
  const activeRules = active?.rules ?? { sections: {}, contexts: {}, tools: {} };

  const layerFor = (writeScope) => {
    if (writeScope === "global") return globalRules;
    if (writeScope === "project") return projectRules;
    if (writeScope === "session") return sessionRules;
    return activeRules;
  };
  const ownCap = (writeScope, key) => {
    if (writeScope === "global") return store.global().caps?.[key];
    if (writeScope === "project") return store.getProject(project.id)?.caps?.[key];
    if (writeScope === "session") return store.sessionCaps(sessionId)?.[key];
    return undefined;
  };

  const allCaps = [...catalog.skills, ...catalog.mcp, ...catalog.plugins].map((entry) => ({
    id: `cap:${entry.key}`,
    type: "cap",
    name: entry.key,
    label: entry.name,
    tokens: Number(entry.tokens ?? 0),
    editable: false,
    summary: entry.summary ?? "",
  }));
  const sectionItems = (prompt.sections ?? []).map((item) => ({
    id: `section:${item.name}`,
    type: "section",
    name: item.name,
    tokens: Number(item.tokens ?? estimateTokens(String(item.text ?? ""))),
    editable: true,
    summary: previewOf(String(item.text ?? ""), 80),
  }));
  const contextItems = (prompt.contexts ?? []).map((item) => ({
    id: `context:${item.name}`,
    type: "context",
    name: item.name,
    tokens: Number(item.tokens ?? estimateTokens(String(item.text ?? ""))),
    editable: true,
    summary: previewOf(String(item.text ?? ""), 80),
  }));
  const toolItems = (prompt.tools ?? []).map((item) => ({
    id: `tool:${item.name}`,
    type: "tool",
    name: item.name,
    tokens: Number(item.tokens ?? estimateTokens(JSON.stringify(item))),
    editable: false,
    summary: previewOf(String(item.description ?? ""), 80),
  }));

  const decorate = (item, writeScope) => {
    const rules = layerFor(writeScope);
    const rule = item.type === "tool" ? rules.tools?.[item.name] : item.type === "section" ? rules.sections?.[item.name] : item.type === "context" ? rules.contexts?.[item.name] : null;
    const value = item.type === "cap" ? ownCap(writeScope, item.name) : undefined;
    return {
      ...item,
      enabled: item.type === "cap" ? value !== false && value !== "hidden" : !(rule?.enabled === false || rule?.hidden === true),
      currentRule: rule ?? null,
      currentValue: value ?? null,
    };
  };

  let scope = wantScope;
  let writeScope = wantScope === "parts" ? "parts" : wantScope === "session" ? "session" : wantScope === "project" ? "project" : "global";
  let scopeId = writeScope === "global" ? "global" : writeScope === "project" ? project.id : null;
  let modeId = writeScope === "parts" ? active?.id ?? null : null;

  let items = [];
  if (scope === "global" || scope === "project") {
    items = [
      ...allCaps.map((item) => decorate(item, writeScope)),
      ...sectionItems.map((item) => decorate(item, writeScope)),
      ...toolItems.map((item) => decorate(item, writeScope)),
    ];
  } else if (scope === "session") {
    items = [
      ...allCaps.map((item) => decorate(item, "session")),
      ...sectionItems.map((item) => decorate(item, "session")),
      ...toolItems.map((item) => decorate(item, "session")),
    ];
  } else if (scope === "parts") {
    items = [
      ...sectionItems.map((item) => decorate(item, "parts")),
      ...contextItems.map((item) => decorate(item, "parts")),
      ...toolItems.map((item) => decorate(item, "parts")),
    ];
  } else if (scope === "item") {
    const wanted = String(body.itemId ?? body.id ?? "");
    const capCandidates = allCaps.map((item) => decorate(item, "project"));
    const partCandidates = [
      ...sectionItems.map((item) => decorate(item, "parts")),
      ...contextItems.map((item) => decorate(item, "parts")),
      ...toolItems.map((item) => decorate(item, "parts")),
    ];
    const found = [...capCandidates, ...partCandidates].find((item) => item.id === wanted || item.name === wanted);
    if (!found) throw new Error(`找不到分析条目：${wanted || "(空)"}`);
    const wantedLayer = String(body.writeScope ?? "");
    if (["global", "project", "parts", "session"].includes(wantedLayer)) {
      writeScope = wantedLayer;
    } else {
      // 行内入口在「构成」页，默认写当前模式层；能力项只可能在项目/会话层。
      writeScope = found.type === "cap" ? (sessionId ? "session" : "project") : "parts";
    }
    scopeId = writeScope === "project" ? project.id : null;
    modeId = writeScope === "parts" ? active?.id ?? null : null;
    items = [found];
  } else {
    throw new Error(`未知的 AI 作用域：${scope}`);
  }

  const route = await resolveRoute(runtime.ctx, agent);
  const normalized = items
    .filter((item) => Number.isFinite(item.tokens) || item.tokens === 0)
    .map((item) => ({ ...item, tokens: Math.max(0, Math.round(Number(item.tokens ?? 0))) }));
  return {
    scope,
    writeScope,
    scopeId,
    projectId: project.id,
    sessionId: sessionId || null,
    modeId,
    revision: store.revision,
    scopeKey: `${scope}:${writeScope}:${scopeId ?? ""}:${sessionId ?? ""}:${modeId ?? ""}`,
    focus: body.focus ?? "",
    items: normalized,
    route,
    agent,
    layers,
    projectedTotal: (prompt.sections ?? []).concat(prompt.contexts ?? [], prompt.tools ?? []).reduce((sum, item) => sum + Number(item.tokens ?? 0), 0),
    impacts: [],
  };
}

function aiServiceFor(runtime) {
  if (!runtime.aiService) {
    runtime.aiService = createAiService({
      store: runtime.store,
      ctx: runtime.ctx,
      collect: (body) => collectAiEvidence(runtime, body),
      getLlm: () => {
        try {
          return getService(runtime.ctx, "llm");
        } catch {
          return null;
        }
      },
    });
  }
  return runtime.aiService;
}

async function buildState(runtime, sessionId) {
  const store = runtime.store;
  const workspaces = syncWorkspaces(runtime);
  const prompt = attachTools(runtime, await promptFor(runtime, sessionId));
  const cwd = await sessionCwd(runtime, sessionId);
  const project = store.projectForCwd(cwd);
  const caps = {
    ...store.capsFor(project.id),
    ...store.sessionCaps(sessionId),
  };
  const awake = sessionId ? [...(awakeSet(runtime, sessionId) ?? [])] : [];
  for (const key of awake) caps[key] = true;
  const catalog = capabilityCatalog(runtime, sessionId ?? null, cwd);
  const capabilities = applyCaps(catalog, caps);
  const plan = capPlan(catalog, caps);
  const layers = store.layersForSession(project.id, sessionId);
  const projected = projectRequest(runtime, prompt, plan, layers);
  const effective = sessionId ? runtime.effectiveByAgent?.get(sessionId) ?? null : null;

  // 「上次压缩」只对同一个会话有意义，别的会话打开面板时不要串台。
  const remembered = runtime.lastCompact ?? null;
  const lastCompactForSession =
    remembered && (!sessionId || !remembered.sessionId || String(remembered.sessionId) === String(sessionId))
      ? remembered
      : null;

  let aiRoute = null;
  try {
    const agent = sessionId ? await resolveAgent(runtime.ctx, sessionId) : null;
    aiRoute = await resolveRoute(runtime.ctx, agent);
  } catch {
    aiRoute = null;
  }

  return {
    ok: true,
    version: pluginVersion(),
    dataDir: store.file,
    activeModeId: store.activeModeId,
    modes: store.list().map((mode) => ({
      id: mode.id,
      name: mode.name,
      note: mode.note ?? "",
      builtin: mode.builtin === true,
      rules: mode.rules,
      stats: ruleStats(mode.rules),
    })),
    prompt,
    // 下一轮真正会发出去的估算：已扣掉本会话/项目/能力关掉的段与工具，并计入简介。
    projected: {
      at: projected.at,
      total: projected.total,
      sections: projected.sections.reduce((sum, item) => sum + item.tokens, 0),
      contexts: projected.contexts.reduce((sum, item) => sum + item.tokens, 0),
      tools: projected.tools.reduce((sum, item) => sum + item.tokens, 0),
      removed: projected.removed,
      removedTokens: projected.removedTokens ?? 0,
    },
    effective: effective
      ? { at: effective.at, sections: effective.sections, contexts: effective.contexts, tools: effective.tools, total: effective.total }
      : null,
    sessionCwd: cwd,
    projects: store.projects().map((item) => ({
      id: item.id,
      name: item.name,
      cwd: item.cwd,
      parentId: item.parentId,
      note: item.note ?? "",
      builtin: item.builtin === true,
      auto: item.auto === true,
      workspaceId: item.workspaceId ?? null,
      missing: item.missing === true,
      caps: item.caps ?? {},
      sections: item.sections ?? {},
      tools: item.tools ?? {},
      resolvedCaps: store.capsFor(item.id),
      resolved: store.layersFor(item.id),
      chain: store.chain(item.id).map((node) => node.id),
      matched: item.id === project.id,
    })),
    workspaces,
    // 全局层：对所有项目生效的那一份配置。
    global: store.scopeRules("global"),
    activeProjectId: project.id,
    awake,
    brief: { enabled: store.briefEnabled(), preview: briefPreview(runtime, sessionId) },
    autoCompact: store.autoCompact(),
    ai: aiServiceFor(runtime).state({ sessionId, route: aiRoute }),
    sessionCaps: sessionId ? store.sessionCaps(sessionId) : {},
    // 胶囊里的「提示段 / 工具」两页要显示本会话自己的覆盖，和项目继承分开。
    sessionRules: sessionId ? store.sessionRules(sessionId) : { sections: {}, tools: {} },
    compaction: await compactionStatus(runtime, undefined, sessionId),
    lastCompact: lastCompactForSession,
    pendingCompact: runtime.pendingCompact ? [...runtime.pendingCompact.keys()] : [],
    compactDiag: {
      auto: runtime.autoCompact === true,
      busy: runtime.compactBusy ? [...runtime.compactBusy] : [],
      liveAgents: (() => {
        try {
          const svc = getService(runtime.ctx, "agents");
          return svc?.list ? svc.list().length : 0;
        } catch {
          return 0;
        }
      })(),
    },
    capabilities,
    capDiag: runtime.capDiag ?? null,
    sessions: runtime.snapshots.sessions(),
    toolRestricted: (runtime.agentRestrictions?.size ?? 0) > 0,
    agentRestrictions: runtime.agentRestrictions?.size ?? 0,
    agentDiag: runtime.agentDiag ?? null,
    lastError: runtime.lastError || "",
  };
}

/**
 * 轮询兜底：会话空闲下来就补压。
 * 为什么不用 session/event 就够——它可以错过（插件重载、turn/end 与压缩窗口错位），
 * 而「队里还有活」这件事本身就是状态，每 8 秒看一次最稳。
 */
async function tickCompaction(runtime) {
  const pending = runtime.pendingCompact ?? (runtime.pendingCompact = new Map());
  const autoSettings = autoCompactSettings(runtime);
  if (!pending.size && (!runtime.autoCompact || !autoSettings.enabled)) return;
  const busy = runtime.compactBusy ?? (runtime.compactBusy = new Set());
  if (busy.size) return;
  const agentsSvc = getService(runtime.ctx, "agents");
  const meter = getService(runtime.ctx, "tokenMeter");
  const live = (() => {
    try {
      return agentsSvc?.roots ? agentsSvc.roots() : agentsSvc?.list ? agentsSvc.list() : [];
    } catch {
      return [];
    }
  })();
  const idleEnough = (agent) => {
    try {
      if (!agentsSvc?.turnBoundaryOf) return true;
      return agentsSvc.turnBoundaryOf(agent.session).openTurnStartSeq === null;
    } catch {
      return false;
    }
  };
  const run = async (agent, sessionId, why, ratio) => {
    busy.add(sessionId);
    runtime.lastCompact = { at: Date.now(), sessionId, running: true, ratio, why };
    try {
      const result = await compactSession(runtime, sessionId, why);
      rememberCompact(runtime, { at: Date.now(), ...result, ratio, error: null });
      runtime.lastError = "";
    } catch (err) {
      const message = String(err?.message ?? err);
      rememberCompact(runtime, { at: Date.now(), sessionId, ratio, why, error: message });
      // 又是「还在跑」——放回队里，下一轮空闲再试，别把用户点的压缩丢掉。
      if (/idle|busy|waking/i.test(message)) pending.set(sessionId, { at: Date.now(), why: "queued" });
    } finally {
      busy.delete(sessionId);
    }
  };
  // 1) 用户点过「立即压缩」但当时在忙的，优先补上。
  for (const [sessionId, item] of [...pending.entries()]) {
    // 会话早就关了或者一直没出现，排队项别永远挂着。
    if (item?.at && Date.now() - item.at > 10 * 60 * 1000) {
      pending.delete(sessionId);
      continue;
    }
    const agent = live.find((entry) => String(entry?.id) === String(sessionId));
    if (!agent || !idleEnough(agent)) continue;
    pending.delete(sessionId);
    await run(agent, sessionId, item?.why ?? "queued", null);
    return;
  }
  // 2) 自动兜底：窗口压力超过阈值就压一次（阈值可在面板里配）。
  if (!runtime.autoCompact || !autoSettings.enabled) return;
  for (const agent of live) {
    const sessionId = String(agent?.id ?? "");
    if (!sessionId || !idleEnough(agent)) continue;
    let ratio = 0;
    try {
      const pressure = meter?.contextPressure?.(agent.session);
      if (pressure?.contextWindow) ratio = Number(pressure.pressureTokens ?? 0) / Number(pressure.contextWindow);
    } catch {
      continue;
    }
    if (!Number.isFinite(ratio) || ratio < autoSettings.ratio) continue;
    await run(agent, sessionId, "auto", ratio);
    return;
  }
}

function resolveCompaction(runtime, agent) {
  const direct =
    (agent?.ctx ? getService(agent.ctx, "compaction") : undefined) ?? getService(runtime.ctx, "compaction");
  if (direct) {
    runtime.compactionSeen = true;
    return direct;
  }
  const presets = getService(runtime.ctx, "agentPresets");
  if (presets && typeof presets.serviceFor === "function") {
    try {
      const scoped = presets.serviceFor(agent, "compaction") ?? undefined;
      if (scoped) runtime.compactionSeen = true;
      return scoped;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function runAction(runtime, body) {
  const action = String(body?.action ?? "");
  const store = runtime.store;

  switch (action) {
    case "activate": {
      const mode = store.activate(body.id);
      invalidateRuntime(runtime);
      return { activated: mode.id };
    }
    case "createMode": {
      const mode = store.create({ name: body.name, from: body.from });
      return { mode: { id: mode.id, name: mode.name } };
    }
    case "renameMode": {
      const mode = store.rename(body.id, body.name);
      return { mode: { id: mode.id, name: mode.name } };
    }
    case "deleteMode": {
      store.remove(body.id);
      invalidateRuntime(runtime);
      return { deleted: body.id };
    }
    case "resetMode": {
      store.reset(body.id);
      invalidateRuntime(runtime);
      return { reset: body.id };
    }
    case "setRule": {
      const mode = store.setRule(body.kind, body.name, body.patch ?? {});
      if (body.kind === "tools" || (body.kind === "sections" && String(body.name).startsWith("tool:"))) {
        resetRestrictions(runtime);
      }
      runtime.effectiveByAgent?.clear();
      runtime.capDiag = null;
      return { mode: { id: mode.id, name: mode.name } };
    }
    case "createProject": {
      const project = store.createProject(body);
      invalidateRuntime(runtime);
      return { project: { id: project.id, name: project.name } };
    }
    case "updateProject": {
      const project = store.updateProject(body.id, body.patch ?? body);
      invalidateRuntime(runtime);
      return { project: { id: project.id, name: project.name, cwd: project.cwd, parentId: project.parentId } };
    }
    case "deleteProject": {
      const target = store.getProject(body.id);
      if (target?.auto) {
        // 抛出去才会变成 {ok:false,error}；自动项目删了也会在下次同步时回来。
        throw new Error("工作区项目是自动同步的，不能删除；不想用就把它的开关全关掉。");
      }
      store.removeProject(body.id);
      invalidateRuntime(runtime);
      return { deleted: body.id };
    }
    case "setCap": {
      // enabled：true 加载 / false 只留简介 / "hidden" 完全不显示 / null 删掉覆盖回到继承值。
      const value = normalizeCapValue(body.enabled === undefined ? body.value : body.enabled);
      if (body.scope === "session") {
        if (!body.sessionId) throw new Error("会话级开关需要 sessionId");
        const caps = store.setSessionCap(body.sessionId, body.key, value);
        invalidateRuntime(runtime);
        return { sessionCaps: caps };
      }
      // 新工作区的项目可能还没同步进表里，先补一条再改开关。
      if (body.projectId && !store.getProject(body.projectId)) {
        store.ensureProject(body.project ?? { id: body.projectId });
      }
      const project = store.setCap(body.projectId, body.key, value);
      invalidateRuntime(runtime);
      return { project: { id: project.id, caps: project.caps } };
    }
    case "setCaps": {
      // 一键全开 / 全关：projectId="*" 表示所有项目，group 可只作用于技能 / MCP / 插件。
      const state = await buildState(runtime, body.sessionId);
      const catalog = state.capabilities ?? { skills: [], mcp: [], plugins: [] };
      const group = String(body.group ?? "all");
      const pool =
        group === "skills" ? catalog.skills :
        group === "mcp" ? catalog.mcp :
        group === "plugins" ? catalog.plugins :
        [...catalog.skills, ...catalog.mcp, ...catalog.plugins];
      const editable = pool.filter((entry) => entry.readOnly !== true);
      let keys = editable.map((entry) => entry.key);
      if (pool.length > 0 && editable.length === 0) {
        return { touched: 0, projects: 0, scopeProjects: 0, scopeKeys: 0 };
      }
      if (keys.length === 0) {
        // 目录还没算出来时退一步：用现有项目里出现过的 key，别让按钮点了没反应。
        keys = [...new Set(store.projects().flatMap((item) => Object.keys(item.caps ?? {})))];
      }
      // enabled：true 全开 / false 全留简介 / "hidden" 全隐藏 / null 全部回到继承值。
      const enabled = normalizeCapValue(body.enabled === undefined ? body.value : body.enabled);
      const targets = body.projectId === "*" ? store.projects().map((item) => item.id) : [body.projectId ?? state.activeProjectId];
      let touched = 0;
      let changedProjects = 0;
      for (const id of targets) {
        const count = store.setCaps(id, keys, enabled);
        if (count > 0) changedProjects += 1;
        touched += count;
      }
      invalidateRuntime(runtime);
      return { touched, projects: changedProjects, scopeProjects: targets.length, scopeKeys: keys.length };
    }
    // 系统提示段 / 系统工具的层级规则：scopeId 传 "global" 或项目 id。
    case "setScopeRule": {
      const scopeId = String(body.scopeId ?? "");
      if (scopeId !== "global" && !store.getProject(scopeId)) throw new Error("项目不存在");
      const result = store.setScopeRule(scopeId, String(body.kind ?? ""), String(body.name ?? ""), body.patch ?? null);
      invalidateRuntime(runtime);
      return { scopeRule: { scopeId, kind: body.kind, name: result.key, rule: result.rule } };
    }
    case "setSessionRule": {
      // 会话级的系统提示段 / 系统工具覆盖：patch 为 null 时撤销。
      if (!body.sessionId) throw new Error("会话级规则需要 sessionId");
      const result = store.setSessionRule(body.sessionId, String(body.kind ?? ""), String(body.name ?? ""), body.patch ?? null);
      invalidateRuntime(runtime);
      return {
        sessionRule: { sessionId: body.sessionId, kind: body.kind, name: result.key, rule: result.rule },
        sessionRules: store.sessionRules(body.sessionId),
      };
    }
    case "setBrief": {
      store.setBrief(body.enabled);
      runtime.effectiveByAgent?.clear();
      runtime.capDiag = null;
      return { brief: store.briefEnabled() };
    }
    case "setAutoCompact": {
      const next = store.setAutoCompact({ enabled: body.enabled, ratio: body.ratio });
      invalidateRuntime(runtime);
      return { autoCompact: next };
    }
    case "setAi": {
      const patch = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.impactScan === "string") patch.impactScan = body.impactScan;
      if (body.privacyAccepted === true) patch.privacyAcceptedAt = new Date().toISOString();
      if (body.privacyAccepted === false) patch.privacyAcceptedAt = null;
      const next = store.setAi(patch);
      return { ai: next };
    }
    case "aiSuggest": {
      const service = aiServiceFor(runtime);
      const suggestion = await service.suggest(body);
      return { suggestion, suggestionId: suggestion.id };
    }
    case "aiLast": {
      const service = aiServiceFor(runtime);
      return service.last(body) ?? { suggestion: null, stale: false };
    }
    case "aiApply": {
      const service = aiServiceFor(runtime);
      const result = await service.apply(body);
      invalidateRuntime(runtime);
      return result;
    }
    case "aiUndo": {
      const service = aiServiceFor(runtime);
      const result = await service.undo(body);
      invalidateRuntime(runtime);
      return result;
    }
    case "session": {
      const agent = await resolveAgent(runtime.ctx, body.sessionId);
      if (!agent) return { session: { ok: false, error: "找不到该会话的 agent（可能还没启动）" } };
      const breakdown = sessionBreakdown(runtime.ctx, agent);
      return { session: breakdown ?? { ok: false, error: "tokenMeter 不可用" } };
    }
    // 只算提示词、不发送：浏览器半拿去写进输入框，用户自己决定发不发。
    case "prompt": {
      const text = buildCompressionPrompt({
        groups: body.groups,
        note: body.note,
        modeName: store.active()?.name,
      });
      return { prompt: { text, tokens: estimateTokens(text) } };
    }
    // 真·压缩：交给宿主 compaction 服务做摘要并替换区间，不指望模型自己调 compress。
    case "diag": {
      const agent = await resolveAgent(runtime.ctx, String(body?.sessionId ?? ""));
      const probe = (c) => {
        if (!c) return null;
        const out = {};
        for (const n of ["compaction", "tokenMeter", "sessionController", "agents"]) {
          try { out[n] = Boolean(c.get(n)); } catch { out[n] = "err"; }
        }
        return out;
      };
      const presets = getService(runtime.ctx, "agentPresets");
      let presetInfo = null;
      if (presets && agent) {
        try {
          presetInfo = {
            composed: presets.composedPreset?.(agent.ctx) ?? null,
            viaServiceFor: Boolean(presets.serviceFor?.(agent, "compaction")),
            attempts: ["compaction", "biliBasicCompactionPolicy", "commands"].map((n) => {
              try {
                return [n, Boolean(presets.serviceFor?.(agent, n))];
              } catch (error) {
                return [n, "err:" + String(error?.message ?? error)];
              }
            }),
          };
        } catch (error) {
          presetInfo = { error: String(error?.message ?? error) };
        }
      }
      let commandCount = null;
      let commandNames = null;
      try {
        const commands = getService(runtime.ctx, "commands");
        if (commands) {
          const list = commands.list(agent);
          commandCount = list.length;
          commandNames = list.map((item) => item.name);
        }
      } catch {
        commandCount = "err";
      }
      return {
        diag: {
          root: probe(runtime.ctx.root),
          ctx: probe(runtime.ctx),
          agent: agent ? probe(agent.ctx) : null,
          agentHasCtx: Boolean(agent && agent.ctx),
          presetInfo,
          commandCount,
          commandNames,
        },
      };
    }
    case "compact": {
      const sessionId = String(body?.sessionId ?? "");
      try {
        const compact = await compactSession(runtime, sessionId, "manual");
        rememberCompact(runtime, { at: Date.now(), ...compact, error: null });
        return { compact };
      } catch (err) {
        const message = String(err?.message ?? err);
        // 宿主拒绝的理由只有一种值得排队：这一轮还在跑，turn/end 之后它就空闲了。
        if (/idle/i.test(message)) {
          const pending = runtime.pendingCompact ?? (runtime.pendingCompact = new Map());
          pending.set(sessionId, { at: Date.now(), why: "manual" });
          runtime.lastCompact = { at: Date.now(), sessionId, queued: true, error: message };
          return {
            compact: { sessionId, queued: true, compacted: false, reason: message },
            message: "本轮还在跑，已经排队：这一轮结束后会自动压缩。",
          };
        }
        throw err;
      }
    }
    // 自检：看清「谁空闲、压力多少、队里有没有活」，用来判断轮询补压为什么没动。
    case "tickdiag": {
      const agentsSvc = getService(runtime.ctx, "agents");
      const meter = getService(runtime.ctx, "tokenMeter");
      const live = (() => {
        try {
          return agentsSvc?.roots ? agentsSvc.roots() : agentsSvc?.list ? agentsSvc.list() : [];
        } catch {
          return [];
        }
      })();
      const rows = live.map((agent) => {
        let boundary = null;
        let boundaryError = null;
        try {
          boundary = agentsSvc?.turnBoundaryOf ? agentsSvc.turnBoundaryOf(agent.session) : null;
        } catch (err) {
          boundaryError = String(err?.message ?? err);
        }
        let ratio = null;
        try {
          const pressure = meter?.contextPressure?.(agent.session);
          if (pressure?.contextWindow) ratio = Number(pressure.pressureTokens ?? 0) / Number(pressure.contextWindow);
        } catch {
          /* 读不到就留 null */
        }
        return {
          id: String(agent?.id ?? ""),
          hasSession: Boolean(agent?.session),
          boundaryError,
          openTurnStartSeq: boundary?.openTurnStartSeq ?? null,
          ratio,
        };
      });
      return {
        tickdiag: {
          hasAgents: Boolean(agentsSvc),
          hasRoots: Boolean(agentsSvc?.roots),
          hasTurnBoundaryOf: Boolean(agentsSvc?.turnBoundaryOf),
          pending: [...(runtime.pendingCompact ?? new Map()).keys()],
          busy: [...(runtime.compactBusy ?? new Set())],
          rows,
        },
      };
    }
    // 手动催一次轮询，省得等 8 秒。
    case "tick": {
      await tickCompaction(runtime);
      return {
        tick: {
          lastCompact: runtime.lastCompact ?? null,
          pending: [...(runtime.pendingCompact ?? new Map()).keys()],
        },
      };
    }
    case "inject": {
      const result = await injectCompressionPrompt(runtime.ctx, {
        sessionId: body.sessionId,
        groups: body.groups,
        note: body.note,
        modeName: store.active()?.name,
        mode: body.mode,
      });
      runtime.lastInjection = { at: Date.now(), requestId: result.requestId };
      return { injected: { requestId: result.requestId, text: result.text } };
    }
    // 自检：真正走一遍装配 waterfall（不带 __ccProbe），看到的就是模型会拿到的那份。
    case "check": {
      // 端到端自检：用真实 agent 跑一次装配，看裁剪后的段名、简介与工具数。
      const agent = await resolveAgent(runtime.ctx, String(body?.sessionId ?? ""));
      if (!agent) throw new Error("找不到该会话的 agent（先在对话里发一条消息）");
      const assembled = await runtime.ctx.systemPrompt.assemble({ agent });
      const sections = (assembled.sections ?? []).map((item) => ({
        name: item.name,
        tokens: estimateTokens(String(item.text ?? "")),
      }));
      const brief = sections.find((item) => item.name === "context-control:brief");
      return {
        check: {
          sessionId: body?.sessionId ?? null,
          nonEmptySections: sections.filter((item) => item.tokens > 0).length,
          hasBrief: Boolean(brief),
          briefTokens: brief?.tokens ?? 0,
          briefText: brief ? String((assembled.sections ?? []).find((item) => item.name === "context-control:brief")?.text ?? "") : "",
          liveTools: (() => {
            try {
              return getService(runtime.ctx, "tools")?.schemas?.()?.length ?? null;
            } catch {
              return null;
            }
          })(),
          capDiag: runtime.capDiag ?? null,
        },
      };
    }
    case "probe": {
      const assembled = await runtime.ctx.systemPrompt.assemble({});
      const lines = [...(assembled.sections ?? []), ...(assembled.contexts ?? [])]
        .filter((item) => String(item?.text ?? "").trim().length > 0)
        .map((item) => ({ name: item.name, tokens: estimateTokens(String(item.text ?? "")) }));
      let liveTools = null;
      let diag = null;
      try {
        const service = getService(runtime.ctx, "tools");
        const schemas = service?.schemas?.() ?? [];
        liveTools = schemas.length;
        diag = {
          keys: Object.keys(service ?? {}),
          hasRestrict: typeof service?.restrict,
          ptyNames: schemas.map((t) => t.name).filter((n) => /pty/i.test(n ?? "")),
        };
      } catch (err) {
        diag = { error: String(err?.message ?? err) };
      }
      return {
        probe: {
          liveToolCount: liveTools,
          diag,
          names: (assembled.sections ?? []).map((item) => item.name),
          contexts: (assembled.contexts ?? []).map((item) => item.name),
          nonEmpty: lines,
          total: lines.reduce((sum, item) => sum + item.tokens, 0),
        },
      };
    }
    default:
      throw new Error(`未知操作：${action || "(空)"}`);
  }
}

async function handleApi(runtime, request, response) {
  const url = new URL(request.url ?? API_PATH, "http://127.0.0.1");
  const action = url.searchParams.get("action") ?? "";

  if (request.method === "GET" || request.method === "HEAD") {
    try {
      if (action === "session") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const agent = await resolveAgent(runtime.ctx, sessionId);
        const breakdown = agent ? sessionBreakdown(runtime.ctx, agent) : null;
        sendJson(response, 200, {
          ok: Boolean(breakdown?.ok),
          session: breakdown ?? { ok: false, error: "找不到该会话的 agent（可能还没启动）" },
        });
        return;
      }
      sendJson(response, 200, await buildState(runtime, url.searchParams.get("sessionId") ?? undefined));
    } catch (err) {
      sendJson(response, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "method not allowed" });
    return;
  }

  try {
    const body = await readBody(request);
    const result = await runAction(runtime, body);
    const payload = { ok: true, ...result };
    // 配置类操作顺带把新状态回给界面，省一次往返；会话/注入不回（不需要重算装配）。
    const action2 = String(body?.action ?? "");
    if (action2 !== "session" && action2 !== "inject") {
      payload.state = await buildState(runtime, body?.sessionId);
    }
    sendJson(response, 200, payload);
  } catch (err) {
    sendJson(response, 200, { ok: false, error: String(err?.message ?? err) });
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const store = new ModeStore(config);
  const snapshots = new SnapshotMemory(Number(config.snapshotLimit) > 0 ? Number(config.snapshotLimit) : 24);

  const runtime = {
    ctx,
    config,
    store,
    snapshots,
    startedAt: Date.now(),
    agentRestrictions: new Map(),
    agentDiag: null,
    lastError: "",
    lastInjection: null,
    lastCompact: store.lastCompact(),
  };

  // 首轮第一步就生效：创建 agent 时先把工具限制挂上，别等到
  // system-prompt/assemble——宿主那时已经 tools.resolve() 过了。
  ctx.on("agent/created", async ({ agent } = {}) => {
    try {
      if (agent) bindCapabilityRestriction(runtime, agent);
    } catch (err) {
      runtime.lastError = `创建时会话限制失败：${err?.message ?? err}`;
    }
  });

  // —— 1. 组装请求时按规则裁剪 ——————————————————————————————
  ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const assembled = await next();
    try {
      // 记的是「过滤前」的完整装配：界面要能看见被关掉的模块，才能再打开。
      // 会话键优先用 agent.id；没有 agent 时退到 scope.id（dsh-ops 就是拿 scope 当键用的）。
      const agentId =
        context?.agent?.id ??
        (typeof context?.scope?.id === "string" ? context.scope.id : null);
      snapshots.remember(agentId, describeAssembly(assembled));
    } catch {
      /* 快照失败不影响请求 */
    }

    // 诊断：记一次 agent 的形状，界面里能看到工具限制到底有没有落地。
    try {
      const agent = context?.agent;
      if (agent) {
        runtime.agentDiag = {
          at: Date.now(),
          id: agent.id ?? null,
          keys: Object.keys(agent).slice(0, 24),
          hasCtx: Boolean(agent.ctx),
          ctxToolKeys: agent.ctx?.tools ? Object.keys(agent.ctx.tools).slice(0, 16) : null,
          scopedRestrict: typeof (agent.ctx?.tools?.restrict ?? agent.tools?.restrict),
        };
      }
    } catch {
      /* 诊断失败无所谓 */
    }

    if (context && context.__ccProbe) return assembled;

    // 能力目录：技能 / MCP / 插件三类的开关，按「这个会话属于哪个项目」解析。
    // 限制在 agent/created 已经挂过；这里再挂一次是幂等的，也兜住非创建路径。
    let caps = null;
    try {
      caps = bindCapabilityRestriction(runtime, context?.agent);
    } catch (err) {
      runtime.lastError = `能力目录读取失败：${err?.message ?? err}`;
    }

    try {
      const plan = caps?.plan ?? { items: [], sections: new Set(), tools: new Set(), skills: new Set() };
      const rules = mergeScopeRules(mergeCapRules(effectiveRules(store), plan), caps?.layers);
      let next = assembled;
      if (!rulesAreNoop(rules)) next = applyRules(next, rules).assembly;
      if (caps) {
        next = { ...next, sections: filterSkillSections(next.sections ?? [], plan.skills) };
        if (store.briefEnabled()) {
          next = withBrief(next, [
            ...plan.items,
            ...scopeBriefItems(caps, assembled),
            ...modeBriefItems(runtime, assembled, plan),
          ]);
        }
      }

      // 记一份「实际会发出去」的装配：界面拿它跟快照对比，就能看出到底省了多少。
      try {
        const agentId = context?.agent?.id ?? null;
        if (agentId) {
          const effective = runtime.effectiveByAgent ?? (runtime.effectiveByAgent = new Map());
          effective.set(agentId, { ...describeAssembly(next), at: Date.now() });
          if (effective.size > 24) {
            const oldest = effective.keys().next().value;
            if (oldest !== undefined) effective.delete(oldest);
          }
        }
      } catch {
        /* 只影响界面显示 */
      }

      return next;
    } catch (err) {
      runtime.lastError = `裁剪失败：${err?.message ?? err}`;
      return assembled;
    }
  });

  // —— 1.4 会话空闲时补压 ————————————————————————————————
  // 宿主的手动压缩只接受「空闲 agent with no waking queued work」：
  // 面板里点「立即压缩」时本轮往往还在跑，于是排进 pendingCompact，
  // 等这一轮的 turn/end 之后再压；顺带做自动兜底——上下文超过阈值也压一次。
  ctx.on("session/event", (session, event) => {
    try {
      if (!event || event.type !== "turn/end") return;
      const sessionId = String(session?.id ?? "");
      if (!sessionId) return;
      const queued = runtime.pendingCompact?.has(sessionId) ?? false;
      let ratio = 0;
      try {
        const meter = getService(runtime.ctx, "tokenMeter");
        const pressure = meter?.contextPressure?.(session);
        if (pressure?.contextWindow) {
          ratio = Number(pressure.pressureTokens ?? 0) / Number(pressure.contextWindow);
        }
      } catch {
        /* 读不到压力就不自动压 */
      }
      if (!queued && ratio < autoCompactRatio(runtime)) return;
      runtime.pendingCompact?.delete(sessionId);
      runtime.lastCompact = { at: Date.now(), sessionId, running: true, ratio };
      // 让 turn/end 的收尾先跑完，再动会话日志。
      const attempt = (left) => {
        compactSession(runtime, sessionId, queued ? "queued" : "auto")
          .then((result) => {
            rememberCompact(runtime, { at: Date.now(), ...result, ratio, error: null });
          })
          .catch((err) => {
            const message = String(err?.message ?? err);
            // turn/end 之后 agent 可能还没彻底空闲，隔一会儿再试。
            if (left > 1 && /idle/i.test(message)) {
              setTimeout(() => attempt(left - 1), 1500);
              return;
            }
            rememberCompact(runtime, { at: Date.now(), sessionId, ratio, error: message });
          });
      };
      setTimeout(() => attempt(3), 120);
    } catch {
      /* 补压失败不影响会话 */
    }
  });

  // 轮询补压：session/event 可能错过（重载、turn/end 与压缩窗口错位），
  // 这里每 8 秒看一次「有没有排队、压力是否过高」。
  runtime.autoCompact = true;
  try {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void tickCompaction(runtime).catch((err) => {
          runtime.lastError = `补压失败：${err?.message ?? err}`;
        });
      }, 8000);
      if (typeof timer?.unref === "function") timer.unref();
      return () => clearInterval(timer);
    }, "context-control compaction tick");
  } catch {
    /* 定时器注册失败就算了，session/event 那条还在 */
  }

  // —— 1.5 被项目关掉的技能：拦在「加载」这一步 ————————————————————
  // 技能不在工具表里，restrict 管不到；它们由 toolbox 按 id 懒加载，
  // 所以只能在这一步把「加载一个被关掉的技能」拦下来。
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      const agent = exec?.agent;
      const sessionId = String(agent?.id ?? "");
      const cwd = String(agent?.session?.header?.cwd ?? "");
      const project = store.projectForCwd(cwd);
      const caps = { ...store.capsFor(project.id), ...store.sessionCaps(sessionId) };
      const awake = awakeSet(runtime, sessionId);
      const asks = [];
      const wakes = [];

      // 1) 懒工具箱按 id 加载技能：简介档直接放行并唤醒，隐藏档要用户点头。
      const ids = Array.isArray(exec?.arguments?.ids) ? exec.arguments.ids : [];
      for (const id of ids) {
        if (typeof id !== "string" || !id.startsWith("skill:")) continue;
        const mode = capMode(caps, id);
        if (mode === "brief") wakes.push(id);
        else if (mode === "hidden" && !awake?.has(id)) asks.push(id);
      }

      // 2) 直接调用某个插件 / MCP 的工具：按它所属能力的档位处理。
      const owner = capKeyOfTool(exec?.name);
      if (owner) {
        const mode = capMode(caps, owner);
        if (mode === "brief") wakes.push(owner);
        else if (mode === "hidden" && !awake?.has(owner)) asks.push(owner);
      }

      // 3) 模型自己调 context_control_open 想把隐藏项拉回来：先问一声再放行。
      if (exec?.name === "context_control_open") {
        const target = String(exec?.arguments?.target ?? "").trim();
        if (capMode(caps, target) === "hidden" && !awake?.has(target)) asks.push(target);
      }

      // 只有「保留简介」的才自动恢复：正文立刻回来，不需要等用户确认。
      for (const key of wakes) wakeCap(runtime, sessionId, key);

      if (asks.length > 0) {
        const names = [...new Set(asks)].map(capLabelOf).join("、");
        return {
          kind: "ask",
          reason: `「${project.name}」里把 ${names} 设成了「完全不显示」，这次调用需要你确认。`,
          displayReason: {
            en: `"${project.name}" hides ${names}. Allow this one call?`,
            "zh-CN": `「${project.name}」里 ${names} 设成了「完全不显示」，允许这次调用吗？`,
          },
        };
      }
    } catch {
      /* 拦不住也不能把正常调用弄坏 */
    }
    return next();
  });

  // —— 2. 工具开关 ——————————————————————————————————————————
  // 先把完整工具表抄一份：restrict 一旦生效，schemas() 里就只剩没被关掉的那些了。
  try {
    catalogTools(runtime);
  } catch {
    /* 读不到就等下一次请求时再补 */
  }

  // —— 2.5 给模型一个「自己把简介项打开」的入口 ——————————————————
  // 简介里写了「调用 context_control_open 就能恢复」，那这个工具必须真的存在，
  // 否则模型只能干看着一行说明。
  try {
    const toolsService = getService(ctx, "tools");
    if (toolsService && typeof toolsService.register === "function") {
      ctx.effect(() => {
        const dispose = toolsService.register({
          name: "context_control_open",
          description:
            "恢复一个被「上下文管控」关掉的上下文模块（技能 / MCP 服务 / 插件），让它在本会话里重新完整加载。target 填模块标识：skill:<技能名>、mcp:<服务名>、plugin:<插件名>。保留简介的模块会立即恢复；标为完全不显示的模块需要用户确认。",
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                description: "模块标识，例如 skill:plugin-upgrade、mcp:github、plugin:agent-teams。",
              },
            },
            required: ["target"],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                target: { type: "string" },
                mode: { type: "string" },
                message: { type: "string" },
              },
              required: ["ok", "target", "mode", "message"],
              additionalProperties: false,
            },
            render: (_args, value) => [{ type: "text", text: String(value?.message ?? "") }],
          },
          async execute(args, exec) {
            const target = String(args?.target ?? "").trim();
            const agent = exec?.agent;
            const sessionId = String(agent?.id ?? "");
            const cwd = String(agent?.session?.header?.cwd ?? "");
            const project = store.projectForCwd(cwd);
            const caps = { ...store.capsFor(project.id), ...store.sessionCaps(sessionId) };
            if (!/^(skill|mcp|plugin):.+/.test(target)) {
              return {
                ok: false,
                target,
                mode: "unknown",
                message: `target 要以 skill: / mcp: / plugin: 开头，收到的是「${target}」。`,
              };
            }
            const mode = capMode(caps, target);
            if (mode === "on") {
              return {
                ok: true,
                target,
                mode,
                message: `${capLabelOf(target)} 本来就是加载状态，不需要恢复。`,
              };
            }
            wakeCap(runtime, sessionId, target);
            runtime.effectiveByAgent?.clear();
            runtime.capDiag = null;
            return {
              ok: true,
              target,
              mode,
              message: `已恢复${capLabelOf(target)}，从下一条消息开始完整加载（之前只是按项目配置关掉了）。`,
            };
          },
        });
        return () => {
          try {
            dispose?.();
          } catch {
            /* 已经卸载 */
          }
        };
      }, "context-control open tool");
    }
  } catch (err) {
    runtime.lastError = `注册 context_control_open 失败：${err?.message ?? err}`;
  }

  // —— 3. 浏览器半用的接口 ————————————————————————————————————
  if (ctx.webServer && typeof ctx.webServer.register === "function") {
    ctx.effect(() => {
      const dispose = ctx.webServer.register(
        {
          kind: "exact",
          path: API_PATH,
          handler: (request, response) => {
            void handleApi(runtime, request, response);
          },
        },
        "context-control api",
      );
      return () => {
        try {
          dispose?.();
        } catch {
          /* 已经卸载 */
        }
      };
    }, "context-control:api");
  }

  const logger = ctx.logger;
  logger?.info?.(
    `[context-control] v${pluginVersion()} 已加载 · 模式=${store.active()?.name ?? "?"} · 数据=${store.file}`,
  );
}

export default { name, inject, apply };
