/**
 * 能力目录：把「上下文里的东西」归到 skill / MCP / 插件 三类，并按项目算开关。
 *
 * 为什么这么归：
 *   - 技能没有自己的工具定义，它们以「一行摘要」的形式躺在懒工具箱的目录段里
 *     （`- skill:<名字> — <一句话>`），所以技能 = 目录段里的那一行，开关就是删行。
 *   - MCP 服务的标识是确定的：工具名 `mcp__<服务>__<工具>`，说明段 `mcp:<服务>`。
 *   - 插件的标识只能靠前缀推：说明段按首个 `:` 前缀归组（`agent-teams:usage` → agent-teams），
 *     工具则按名字前缀对齐（`agent_teams_*` → agent-teams）。对齐不上的是框架自带工具，
 *     留给「工具定义」那张卡片逐个开关。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { estimateTokens, previewOf } from "./tokens.js";

/** 这些前缀是 DSH 自带的，不当插件看。 */
export const RESERVED_PREFIXES = new Set([
  "tool",
  "mcp",
  "ui",
  "harness",
  "app",
  "deployment",
  "context",
  "plan",
]);

export const CAP_KINDS = ["skills", "mcp", "plugins"];

export const CAP_KIND_LABELS = {
  skills: "技能",
  mcp: "MCP 服务",
  plugins: "插件",
};

/** 已知插件的显示名（对不上就原样显示 id）。 */
const PLUGIN_LABELS = {
  "agent-teams": "多智能体协作",
  "free-search": "联网搜索",
  "mcp-connector": "MCP 连接器",
  "dsh-ops": "仓库操作",
  toolbox: "懒工具箱",
  "dsh-context": "上下文洞察",
  "billion-context": "上下文压缩",
  hindsight: "记忆库",
  "session-query": "会话检索",
  terminal: "终端",
  "dsh-remote": "远程执行",
  michengai: "人格注入",
};

/** 工具名前缀 → 插件 id。顺序有意义：先长后短。 */
const TOOL_PREFIX_ALIASES = [
  ["agent_teams_", "agent-teams"],
  ["mcp_connector_", "mcp-connector"],
  ["free_search_", "free-search"],
  ["ops_", "dsh-ops"],
  ["acp_", "billion-context"],
  ["hindsight_", "hindsight"],
  ["session_event_", "session-query"],
  ["session_", "session-query"],
  ["terminal_", "terminal"],
  ["remote_", "dsh-remote"],
  ["pua_", "michengai"],
  ["toolbox", "toolbox"],
];

/** 这些工具名没前缀，但仍属于某个插件（按经验补）。 */
const TOOL_NAME_HINTS = {
  compress: "billion-context",
  decompress: "billion-context",
  search_context: "billion-context",
  cache_search: "billion-context",
  dshmarket_update: "plugins-market",
  create_worktree: "worktrees",
  load_workspace_dependencies: "toolchain",
  propose_action: "personalized-pages",
};

function normalize(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** `agent-teams:usage` → `agent-teams`；没有冒号返回空串。 */
export function sectionPrefix(name) {
  const value = String(name ?? "");
  const at = value.indexOf(":");
  return at > 0 ? value.slice(0, at) : "";
}

/**
 * 一个说明段属于哪个能力。
 * `mcp:github` → MCP 服务 github；`agent-teams:usage` → 插件 agent-teams；
 * `tool:bash` / `harness:identity` 这类框架段返回 null（不归能力管）。
 */
export function capForSectionName(name) {
  const prefix = sectionPrefix(name);
  if (!prefix) return null;
  if (prefix === "mcp") {
    const server = String(name).slice(prefix.length + 1);
    return server ? { kind: "mcp", key: `mcp:${server}`, id: server } : null;
  }
  if (RESERVED_PREFIXES.has(prefix)) return null;
  return { kind: "plugins", key: `plugin:${prefix}`, id: prefix };
}

/** `mcp__github__issue_read` → `github`。 */
export function mcpServerOfTool(name) {
  const match = /^mcp__([^_].*?)__/.exec(String(name ?? ""));
  return match ? match[1] : null;
}

/** 工具归哪个插件（MCP 工具返回 null，走 MCP 那一路）。 */
export function pluginOfTool(name) {
  const value = String(name ?? "");
  if (!value || value.startsWith("mcp__")) return null;
  const hinted = TOOL_NAME_HINTS[value];
  if (hinted) return hinted;
  for (const [prefix, plugin] of TOOL_PREFIX_ALIASES) {
    if (value.startsWith(prefix)) return plugin;
  }
  return null;
}

export function pluginLabel(id) {
  return PLUGIN_LABELS[id] ? `${id}（${PLUGIN_LABELS[id]}）` : id;
}

/** 目录段里的一行技能：`- skill:名字 — 摘要`。 */
const SKILL_LINE = /^\s*[-*]\s*`?skill:([^`\s—]+)`?\s*(?:—|-{1,2})\s*(.*)$/;

export function isSkillSection(section) {
  const name = String(section?.name ?? "");
  if (/skill|capabilit/i.test(name)) return true;
  return /(^|\n)\s*[-*]\s*`?skill:/.test(String(section?.text ?? ""));
}

/** 把技能目录段拆成条目。 */
export function parseSkillCatalog(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = SKILL_LINE.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (!name) continue;
    out.push({ name, summary: match[2].trim(), line: line.trim() });
  }
  return out;
}

/**
 * 从目录段里删掉被关闭的技能行；返回新文本与是否还有技能行。
 * 只动 `- skill:` 开头的行，其它说明文字原样保留。
 */
export function filterSkillLines(text, disabled) {
  if (!disabled || disabled.size === 0) return { text, removed: 0 };
  const lines = String(text ?? "").split("\n");
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    const match = SKILL_LINE.exec(line);
    if (match && disabled.has(match[1].trim())) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  if (removed === 0) return { text, removed: 0 };
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

function splitSkillFrontmatter(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!pair) continue;
    let value = pair[2].trim();
    if (value.startsWith(">") || value.startsWith("|")) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[pair[1].toLowerCase()] = value.trim();
  }
  return { meta, body: source.slice(match[0].length) };
}

function firstSkillLine(text) {
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("```") || line.startsWith("<") || line === "---") continue;
    return previewOf(line, 160);
  }
  return "";
}

function readDiskSkill(file, fallbackName) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { meta, body } = splitSkillFrontmatter(text);
  const id = String(meta.name || fallbackName || basename(file, extname(file))).trim();
  if (!id) return null;
  const summary = previewOf(
    String(meta.description || firstSkillLine(body) || "来自磁盘技能目录").replace(/\s+/g, " ").trim(),
    140,
  );
  return {
    kind: "skills",
    key: `skill:${id}`,
    id,
    name: id,
    summary,
    // 没有目录段时这些技能不会进入请求，按 0 计，避免把磁盘清单算成当前占用。
    tokens: 0,
    section: "filesystem",
    source: "filesystem",
    readOnly: true,
  };
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 没有懒工具箱时的兜底：直接扫磁盘上的技能目录。
 *
 * 目录段只由工具箱注入，所以这里只负责「让界面看得见」；这些条目没有可写的
 * 目录行；readOnly 只表示来源是磁盘，档位仍可保存，等目录段恢复后生效。
 */
export function discoverDiskSkills(cwd = "") {
  const roots = [];
  const cwdText = String(cwd ?? "").trim();
  if (cwdText) roots.push(join(cwdText, ".dsh", "skills"));
  const home = homedir();
  roots.push(join(home, ".dsh", "skills"));
  roots.push(join(home, ".dsh", "lazy-toolbox", "skills"));
  roots.push(join(home, ".agents", "skills"));

  const out = [];
  const seen = new Set();
  const visitedRoots = new Set();
  for (const root of roots) {
    if (visitedRoots.has(root)) continue;
    visitedRoots.add(root);
    let dirents;
    try {
      dirents = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (out.length >= 300) break;
      if (dirent.name.startsWith(".")) continue;
      const full = join(root, dirent.name);
      let entry = null;
      if (dirent.isDirectory() || (dirent.isSymbolicLink() && isDirectory(full))) {
        entry = readDiskSkill(join(full, "SKILL.md"), dirent.name);
      } else if (dirent.isFile() && extname(dirent.name).toLowerCase() === ".md") {
        entry = readDiskSkill(full, basename(dirent.name, extname(dirent.name)));
      }
      if (!entry) continue;
      const dedupe = entry.id.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(entry);
    }
  }
  return out;
}

/**
 * 组装能力目录。
 * @param sections 描述过的说明段（{name,text,tokens}）
 * @param tools    描述过的工具（{name,description,tokens}）
 * @param diskSkills 没有目录段时从磁盘发现的技能
 */
export function buildCatalog({ sections = [], tools = [], diskSkills = [] } = {}) {
  const skills = [];
  const skillSeen = new Set();
  for (const section of sections) {
    if (!isSkillSection(section)) continue;
    for (const item of parseSkillCatalog(section.text)) {
      if (skillSeen.has(item.name)) continue;
      skillSeen.add(item.name);
      skills.push({
        kind: "skills",
        key: `skill:${item.name}`,
        id: item.name,
        name: item.name,
        summary: item.summary,
        tokens: estimateTokens(item.line),
        section: section.name,
      });
    }
  }

  // 目录段是懒工具箱注入的；没有它时用磁盘清单兜底。只在完全没解析到技能时兜底，
  // 有目录段时必须以目录段为准（它才是真正会发给模型的那一份）。
  if (skills.length === 0) {
    for (const item of diskSkills) {
      if (skillSeen.has(item.name)) continue;
      skillSeen.add(item.name);
      skills.push({
        kind: "skills",
        key: item.key ?? `skill:${item.name}`,
        id: item.name,
        name: item.name,
        summary: item.summary,
        tokens: item.tokens,
        section: item.section ?? "filesystem",
        source: "filesystem",
        readOnly: true,
      });
    }
  }

  const mcp = new Map();
  const plugins = new Map();

  const ensureMcp = (server) => {
    if (!mcp.has(server)) {
      mcp.set(server, {
        kind: "mcp",
        key: `mcp:${server}`,
        id: server,
        name: server,
        summary: "",
        tokens: 0,
        sectionNames: [],
        toolNames: [],
      });
    }
    return mcp.get(server);
  };
  const ensurePlugin = (id) => {
    if (!plugins.has(id)) {
      plugins.set(id, {
        kind: "plugins",
        key: `plugin:${id}`,
        id,
        name: id,
        summary: "",
        tokens: 0,
        sectionNames: [],
        toolNames: [],
      });
    }
    return plugins.get(id);
  };

  for (const section of sections) {
    const cap = capForSectionName(section.name);
    if (!cap) continue;
    const entry = cap.kind === "mcp" ? ensureMcp(cap.id) : ensurePlugin(cap.id);
    entry.sectionNames.push(section.name);
    entry.tokens += section.tokens ?? 0;
  }

  for (const tool of tools) {
    const server = mcpServerOfTool(tool.name);
    if (server) {
      const entry = ensureMcp(server);
      entry.toolNames.push(tool.name);
      entry.tokens += tool.tokens ?? 0;
      continue;
    }
    const plugin = pluginOfTool(tool.name);
    if (plugin) {
      const entry = ensurePlugin(plugin);
      entry.toolNames.push(tool.name);
      entry.tokens += tool.tokens ?? 0;
    }
  }

  const finish = (entry, label) => {
    const bits = [];
    if (entry.toolNames.length > 0) bits.push(`${entry.toolNames.length} 个工具`);
    if (entry.sectionNames.length > 0) bits.push(`${entry.sectionNames.length} 段说明`);
    entry.summary = entry.summary || `${label}：${bits.join(" · ") || "无内容"}`;
    return entry;
  };

  return {
    skills: skills.sort((a, b) => b.tokens - a.tokens),
    mcp: [...mcp.values()].map((entry) => finish(entry, `MCP 服务 ${entry.id}`)).sort((a, b) => b.tokens - a.tokens),
    plugins: [...plugins.values()]
      .map((entry) => finish(entry, `插件 ${pluginLabel(entry.id)}`))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

/** 目录里每条能力的开关状态（继承链合并后的结果）。 */
/** 一个能力的三种状态：on 完整加载 / brief 只留简介 / hidden 完全不显示。 */
export function capMode(caps, key) {
  const value = caps?.[key];
  if (value === "hidden") return "hidden";
  if (value === false) return "brief";
  if (value === true) return "on";
  return "inherit";
}

/** 是否要摘掉正文：brief 与 hidden 都要摘，区别只在「模型知不知道它存在」。 */
export function isOff(value) {
  return value === false || value === "hidden";
}

export function applyCaps(catalog, caps = {}) {
  const mark = (entry) => ({
    ...entry,
    enabled: !isOff(caps[entry.key]),
    mode: capMode(caps, entry.key),
  });
  return {
    skills: catalog.skills.map(mark),
    mcp: catalog.mcp.map(mark),
    plugins: catalog.plugins.map(mark),
  };
}

/**
 * 把「关掉的能力」翻译成可执行的裁剪动作：
 *   - sections：要摘掉的说明段
 *   - skills  ：要从目录段里删掉的技能行
 *   - tools   ：要 deny 的工具
 *   - brief   ：给模型看的一行简介
 */
export function capPlan(catalog, caps = {}) {
  const sections = new Set();
  const skills = new Set();
  const tools = new Set();
  const items = [];

  for (const entry of [...catalog.skills, ...catalog.mcp, ...catalog.plugins]) {
    const value = caps[entry.key];
    if (!isOff(value)) continue;
    // 完全不显示的项不进简介：模型看不到名字，也就不会主动去找它。
    const hidden = value === "hidden";
    if (entry.kind === "skills") {
      skills.add(entry.name);
      if (!hidden) items.push({ kind: "skills", label: `技能 ${entry.name}`, detail: entry.summary, tokens: entry.tokens });
      continue;
    }
    for (const name of entry.sectionNames ?? []) sections.add(name);
    for (const name of entry.toolNames ?? []) tools.add(name);
    // label 与 detail 必须来自不同信息源，否则简介会自我复读
    // （曾经出现「插件 michengai（人格注入）：插件 michengai（人格注入）：1 个工具…」）。
    const bits = [];
    const toolCount = (entry.toolNames ?? []).length;
    const sectionCount = (entry.sectionNames ?? []).length;
    if (toolCount > 0) bits.push(`${toolCount} 个工具`);
    if (sectionCount > 0) bits.push(`${sectionCount} 段说明`);
    const label = entry.kind === "mcp" ? `MCP ${entry.id}` : `插件 ${pluginLabel(entry.id)}`;
    const detail = bits.length > 0 ? bits.join(" · ") : previewOf(entry.summary, 60);
    if (!hidden) items.push({ kind: entry.kind, label, detail, tokens: entry.tokens });
  }

  return { sections, skills, tools, items };
}

/**
 * 给模型看的「关闭项简介」。
 * 关掉 ≠ 消失：模型仍然知道有这么个东西、大概干什么、要多少 token，
 * 需要时可以说一句「打开某某」，而不是完全看不见。
 */
export function buildBrief(items, { maxItems = 40, totalTokens = 0 } = {}) {
  if (!items || items.length === 0) return "";
  const shown = items.slice(0, maxItems);
  const lines = shown.map((item) => {
    const detail = item.detail ? `：${previewOf(String(item.detail), 70)}` : "";
    return `- ${item.label}${detail}（已关闭，原文不发；约 ${item.tokens} token）`;
  });
  if (items.length > shown.length) lines.push(`- ……另有 ${items.length - shown.length} 项已关闭`);
  const header = totalTokens > 0
    ? `## 已关闭的上下文模块（仅保留简介）\n这些模块按当前项目配置关闭了正文，只保留这一行说明（原文合计约 ${totalTokens} token）。需要其中任何一项时调用 context_control_open（参数 target 填该项的标识，例如 mcp:github），正文会立刻恢复，不用等用户确认。`
    : "## 已关闭的上下文模块（仅保留简介）\n这些模块按当前项目配置关闭了正文，只保留这一行说明。需要其中任何一项时调用 context_control_open 打开，正文会立刻恢复，不用等用户确认。";
  return `${header}\n${lines.join("\n")}`;
}
