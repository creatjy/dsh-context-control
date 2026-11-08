/**
 * 「模式」仓库：一个模式 = 一份针对当前上下文的规则表。
 *
 * 规则表挂在三处，键都是模块名：
 *   - sections：系统提示段落（组装结果里的 section.name）
 *   - contexts：运行时上下文（context.name）
 *   - tools   ：工具定义（tool.name）
 *
 * 每条规则的形状：{ enabled?: boolean, text?: string }
 *   - enabled: false → 组装请求时把这一块从系统提示里摘掉；
 *   - text           → 用这段文本替换原文（编辑）；
 *   - 都没写         → 保持 DSH 原样（= 加载）。
 *
 * 数据落在 profile 目录下的 dsh-context-control/modes.json，
 * 纯 JSON、可手改、删掉即恢复默认。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MAX_TEXT = 200_000;

export const RULE_KINDS = ["sections", "contexts", "tools"];

/** 「工作区默认」是继承链的根：所有项目都从它开始叠加自己的能力开关。 */
export const DEFAULT_PROJECT_ID = "workspace";

const CAP_KEY = /^(skill|mcp|plugin):[\w.@/:+-]{1,120}$/;

/** 内置模式：一个是「什么都不改」的对照组，一个是本次需求里的「上下文管控」。 */
export function defaultState() {
  return {
    version: 4,
    // 每次成功写入 +1；AI 应用/撤销与并发按钮用它判断「你看到的是不是最新配置」。
    revision: 0,
    activeModeId: "context-control",
    brief: { enabled: true },
    // AI 建议默认关闭：不点按钮、不打开开关就不会调用模型。
    ai: { enabled: false, impactScan: "off", privacyAcceptedAt: null },
    // 自动压缩：窗口占用到 ratio 就压一次；enabled=false 时只能手点。
    autoCompact: { enabled: true, ratio: 0.8 },
    // 会话级覆盖：胶囊里改的技能/MCP/插件只作用于这一条会话，不写进项目。
    sessions: {},
    // 全局层：对所有项目生效，项目自己的档位覆盖它。项目之间互不影响。
    global: { caps: {}, sections: {}, tools: {} },
    projects: [
      {
        id: DEFAULT_PROJECT_ID,
        name: "工作区默认",
        cwd: "",
        parentId: null,
        note: "所有项目都继承这里的能力开关；没有匹配到项目的会话只用这一层。",
        builtin: true,
        caps: {},
        sections: {},
        tools: {},
      },
    ],
    modes: [
      {
        id: "full",
        name: "完整上下文",
        note: "DSH 默认行为：全部模块都加载，不做任何删改。想对比「省了多少」时切回这里。",
        builtin: true,
        rules: emptyRules(),
      },
      {
        id: "context-control",
        name: "上下文管控",
        note: "按模块开关与编辑。默认全部加载；关掉或改写哪个模块，就从下一次请求开始生效。",
        builtin: true,
        rules: emptyRules(),
      },
    ],
  };
}

export function emptyRules() {
  return { sections: {}, contexts: {}, tools: {} };
}

function sanitizeRules(raw) {
  const out = emptyRules();
  if (!raw || typeof raw !== "object") return out;
  for (const kind of RULE_KINDS) {
    const source = raw[kind];
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      if (!key || !value || typeof value !== "object") continue;
      const rule = {};
      if (typeof value.enabled === "boolean") rule.enabled = value.enabled;
      if (typeof value.text === "string") rule.text = value.text.slice(0, MAX_TEXT);
      if (Object.keys(rule).length > 0) out[kind][key] = rule;
    }
  }
  return out;
}

function sanitizeMode(raw, index) {
  const id =
    typeof raw?.id === "string" && raw.id.trim()
      ? raw.id.trim().slice(0, 64)
      : `mode-${index}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 40) : "未命名模式",
    note: typeof raw?.note === "string" ? raw.note.slice(0, 400) : "",
    builtin: raw?.builtin === true,
    rules: sanitizeRules(raw?.rules),
  };
}

/** 能力开关的合法值：true 加载 / false 只留简介 / "hidden" 完全不显示。 */
export function normalizeCapValue(value) {
  if (value === "hidden") return "hidden";
  if (value === false) return false;
  if (value === true) return true;
  return null; // 交给调用方当成「删掉覆盖」
}

function sanitizeCaps(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!CAP_KEY.test(key)) continue;
    const next = normalizeCapValue(value);
    if (next !== null) out[key] = next;
  }
  return out;
}

/** 会话级覆盖：只保留最近 50 条会话，避免 modes.json 无限增长。 */
const MAX_SESSION_CAPS = 50;

function sanitizeSessions(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  const rows = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!key || key.length > 120 || !value || typeof value !== "object") continue;
    const caps = sanitizeCaps(value.caps);
    const sections = sanitizeScopeRules(value.sections);
    const tools = sanitizeScopeRules(value.tools);
    if (Object.keys(caps).length === 0 && Object.keys(sections).length === 0 && Object.keys(tools).length === 0) continue;
    rows.push([key, { caps, sections, tools, updatedAt: Number(value.updatedAt) || 0 }]);
  }
  rows.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [key, entry] of rows.slice(0, MAX_SESSION_CAPS)) out[key] = entry;
  return out;
}

/** 会话覆盖只留最近 50 条，避免 modes.json 无限增长。 */
function pruneSessions(sessions) {
  const rows = Object.entries(sessions).sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));
  for (const [oldId] of rows.slice(MAX_SESSION_CAPS)) delete sessions[oldId];
}

/** 段 / 工具的细粒度规则：只收 enabled 与 text，键名原样保留。 */
function sanitizeScopeRules(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!key || key.length > 200 || !value || typeof value !== "object") continue;
    const rule = {};
    if (typeof value.enabled === "boolean") rule.enabled = value.enabled;
    if (typeof value.text === "string") rule.text = value.text.slice(0, MAX_TEXT);
    if (Object.keys(rule).length > 0) out[key] = rule;
  }
  return out;
}

function sanitizeProject(raw, index) {
  const id =
    typeof raw?.id === "string" && raw.id.trim()
      ? raw.id.trim().slice(0, 64)
      : `project-${index}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 60) : "未命名项目",
    cwd: typeof raw?.cwd === "string" ? raw.cwd.trim().slice(0, 400) : "",
    parentId: typeof raw?.parentId === "string" && raw.parentId.trim() ? raw.parentId.trim().slice(0, 64) : null,
    note: typeof raw?.note === "string" ? raw.note.slice(0, 300) : "",
    builtin: raw?.builtin === true,
    // 工作区同步来的项目：auto 丢了就会退化成手动项目，重启后不再跟着注册表走。
    auto: raw?.auto === true,
    workspaceId: typeof raw?.workspaceId === "string" ? raw.workspaceId : null,
    missing: raw?.missing === true,
    caps: sanitizeCaps(raw?.caps),
    // 系统提示段与系统自带工具的覆盖（项目 / 全局两层用同一套结构）。
    sections: sanitizeScopeRules(raw?.sections),
    tools: sanitizeScopeRules(raw?.tools),
  };
}

/** 自动压缩的开关与阈值：阈值限制在 5%–95%，越界就退回 0.8。 */
function sanitizeAutoCompact(raw) {
  const ratio = Number(raw?.ratio);
  return {
    enabled: raw?.enabled !== false,
    ratio: Number.isFinite(ratio) && ratio >= 0.05 && ratio <= 0.95 ? Number(ratio.toFixed(2)) : 0.8,
  };
}

/** 抽屉里「上次压缩」的持久化版本：字段白名单 + 长度上限，重载后还能看到。 */
function sanitizeLastCompact(raw) {
  if (!raw || typeof raw !== "object") return null;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  return {
    at: num(raw.at) ?? 0,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId.slice(0, 200) : null,
    why: typeof raw.why === "string" ? raw.why.slice(0, 20) : null,
    via: typeof raw.via === "string" ? raw.via.slice(0, 40) : null,
    note: typeof raw.note === "string" ? raw.note.slice(0, 500) : "",
    compacted: raw.compacted === true,
    summarySeq: num(raw.summarySeq),
    shadowedTokens: num(raw.shadowedTokens) ?? 0,
    beforeTokens: num(raw.beforeTokens),
    afterTokens: num(raw.afterTokens),
    beforeSurface: num(raw.beforeSurface),
    afterSurface: num(raw.afterSurface),
    ratio: num(raw.ratio),
    error: typeof raw.error === "string" ? raw.error.slice(0, 500) : null,
  };
}

export function sanitizeAi(raw) {
  const out = { enabled: false, impactScan: "off", privacyAcceptedAt: null };
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (raw.impactScan === "on" || raw.impactScan === "off") out.impactScan = raw.impactScan;
  if (typeof raw.privacyAcceptedAt === "string" && raw.privacyAcceptedAt.trim()) {
    out.privacyAcceptedAt = raw.privacyAcceptedAt.trim().slice(0, 64);
  }
  return out;
}

export function sanitizeState(raw) {
  const base = defaultState();
  const state = {
    version: 4,
    revision: Number.isInteger(raw?.revision) && raw.revision >= 0 ? raw.revision : 0,
    activeModeId: base.activeModeId,
    brief: { ...base.brief },
    ai: sanitizeAi(raw?.ai),
    autoCompact: sanitizeAutoCompact(raw?.autoCompact),
    lastCompact: sanitizeLastCompact(raw?.lastCompact),
    sessions: sanitizeSessions(raw?.sessions),
    global: { caps: {}, sections: {}, tools: {} },
    projects: [],
    modes: [],
  };

  state.global = {
    caps: sanitizeCaps(raw?.global?.caps),
    sections: sanitizeScopeRules(raw?.global?.sections),
    tools: sanitizeScopeRules(raw?.global?.tools),
  };

  // —— 项目：继承链的根必须一直在，父子关系不能成环 ——
  const projectSource = Array.isArray(raw?.projects) ? raw.projects : [];
  const projects = projectSource.map(sanitizeProject);
  if (!projects.some((item) => item.id === DEFAULT_PROJECT_ID)) projects.unshift(base.projects[0]);
  const ids = new Set(projects.map((item) => item.id));
  for (const project of projects) {
    if (project.id === DEFAULT_PROJECT_ID) {
      project.parentId = null;
      project.builtin = true;
    }
    if (project.parentId && !ids.has(project.parentId)) project.parentId = null;
    if (project.parentId === project.id) project.parentId = null;
  }
  // 断环：沿 parentId 往上走，走回自己就把父级摘掉。
  for (const project of projects) {
    const seen = new Set([project.id]);
    let cursor = project.parentId;
    while (cursor) {
      if (seen.has(cursor)) {
        project.parentId = null;
        break;
      }
      seen.add(cursor);
      cursor = projects.find((item) => item.id === cursor)?.parentId ?? null;
    }
  }
  state.projects = projects;
  state.brief = { enabled: raw?.brief?.enabled !== false };

  // —— 模式 ——
  if (!Array.isArray(raw?.modes) || raw.modes.length === 0) {
    state.modes = base.modes;
    return state;
  }

  const seen = new Set();
  const modes = [];
  for (const [index, item] of raw.modes.entries()) {
    const mode = sanitizeMode(item, index);
    while (seen.has(mode.id)) mode.id = `${mode.id}-${Math.random().toString(36).slice(2, 6)}`;
    seen.add(mode.id);
    modes.push(mode);
  }
  // 至少保住一个「完整上下文」：用户可以改名，但这条对照组不会被删没。
  if (!modes.some((mode) => mode.id === "full")) modes.unshift(base.modes[0]);

  state.modes = modes;
  state.activeModeId = modes.some((mode) => mode.id === raw.activeModeId) ? raw.activeModeId : modes[0].id;
  return state;
}

export function resolveDataDir(config = {}) {
  if (typeof config.dataDir === "string" && config.dataDir.trim()) return config.dataDir.trim();
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir) return path.join(profileDir, "dsh-context-control");
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const profile = process.env.DSH_PROFILE || "desktop";
  return path.join(home, "profiles", profile, "dsh-context-control");
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

export class ModeStore {
  constructor(config = {}) {
    this.dir = resolveDataDir(config);
    this.file = path.join(this.dir, "modes.json");
    this.state = this.read();
  }

  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return sanitizeState(raw);
    } catch {
      return defaultState();
    }
  }

  save() {
    const next = { ...this.state, version: 4, revision: (Number(this.state.revision) || 0) + 1 };
    try {
      writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.state = next;
      return true;
    } catch (err) {
      this.lastError = String(err?.message ?? err);
      return false;
    }
  }

  get revision() {
    return Number(this.state.revision) || 0;
  }

  ai() {
    return { ...(this.state.ai ?? sanitizeAi(null)) };
  }

  setAi(patch = {}) {
    this.state.ai = sanitizeAi({ ...this.ai(), ...patch });
    this.save();
    return this.ai();
  }

  /**
   * 串行化的一次写入：fn 拿到 state 的深拷贝，返回后只写一次。
   * 供 AI 应用/撤销这类多步变更使用，避免 20 个 set* 产生 20 次写盘。
   */
  async transaction(fn, { validate } = {}) {
    const run = (this._queue ?? Promise.resolve()).then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      if (validate) await validate(draft);
      draft.version = 4;
      draft.revision = (Number(this.state.revision) || 0) + 1;
      writeFileAtomic(this.file, `${JSON.stringify(draft, null, 2)}\n`);
      this.state = draft;
      return result;
    });
    this._queue = run.catch(() => {});
    return run;
  }

  /**
   * 批量应用（同步）：先校验 revision，再在副本上执行，全部成功才写盘。
   * 任一 op 失败都不改当前 state，也不会产生半套规则。
   */
  applyOps(ops, { revision, validate } = {}) {
    if (!Array.isArray(ops) || ops.length === 0) throw new Error("没有要应用的操作");
    if (revision !== undefined && revision !== null) {
      const expected = Number(revision);
      if (!Number.isInteger(expected) || expected !== this.revision) {
        const error = new Error("配置已经被其他操作修改，请刷新后重试");
        error.code = "conflict";
        error.currentRevision = this.revision;
        throw error;
      }
    }
    const draft = structuredClone(this.state);
    for (const op of ops) applyOpToState(draft, op);
    if (validate) {
      const verdict = validate(draft);
      if (verdict === false) throw new Error("操作未通过校验");
    }
    draft.version = 4;
    draft.revision = this.revision + 1;
    writeFileAtomic(this.file, `${JSON.stringify(draft, null, 2)}\n`);
    this.state = draft;
    return draft.revision;
  }

  list() {
    return this.state.modes;
  }

  get activeModeId() {
    return this.state.activeModeId;
  }

  get(id) {
    return this.state.modes.find((mode) => mode.id === id);
  }

  active() {
    return this.get(this.state.activeModeId) ?? this.state.modes[0];
  }

  /** 当前生效的规则表（宿主侧组装请求时读它）。 */
  activeRules() {
    return this.active()?.rules ?? emptyRules();
  }

  activate(id) {
    if (!this.get(id)) throw new Error("模式不存在");
    this.state.activeModeId = id;
    this.save();
    return this.get(id);
  }

  create({ name, from, note } = {}) {
    const source = this.get(from) ?? this.active();
    const label = (typeof name === "string" && name.trim()) || `新模式 ${this.state.modes.length + 1}`;
    const mode = {
      id: `mode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: label.slice(0, 40),
      note: typeof note === "string" ? note.slice(0, 400) : `复制自「${source?.name ?? "完整上下文"}」`,
      builtin: false,
      rules: sanitizeRules(JSON.parse(JSON.stringify(source?.rules ?? emptyRules()))),
    };
    this.state.modes.push(mode);
    this.save();
    return mode;
  }

  rename(id, name) {
    const mode = this.get(id);
    if (!mode) throw new Error("模式不存在");
    const label = String(name ?? "").trim();
    if (!label) throw new Error("模式名不能为空");
    mode.name = label.slice(0, 40);
    this.save();
    return mode;
  }

  remove(id) {
    const mode = this.get(id);
    if (!mode) throw new Error("模式不存在");
    if (mode.id === "full") throw new Error("「完整上下文」是对照组，不能删除");
    this.state.modes = this.state.modes.filter((item) => item.id !== id);
    if (this.state.activeModeId === id) this.state.activeModeId = this.state.modes[0].id;
    this.save();
    return this.active();
  }

  reset(id) {
    const mode = this.get(id);
    if (!mode) throw new Error("模式不存在");
    mode.rules = emptyRules();
    this.save();
    return mode;
  }

  // —— 项目：能力开关按 cwd 归属，父级先合并、子级覆盖 ——

  projects() {
    return this.state.projects;
  }

  getProject(id) {
    return this.state.projects.find((project) => project.id === id) ?? null;
  }

  briefEnabled() {
    return this.state.brief?.enabled !== false;
  }

  setBrief(enabled) {
    this.state.brief = { enabled: enabled !== false };
    this.save();
    return this.state.brief;
  }

  autoCompact() {
    return this.state.autoCompact ?? { enabled: true, ratio: 0.8 };
  }

  setAutoCompact(patch = {}) {
    const current = this.autoCompact();
    const ratio = Number(patch.ratio ?? current.ratio);
    this.state.autoCompact = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled !== false,
      ratio: Number.isFinite(ratio) ? Math.min(0.95, Math.max(0.05, Number(ratio.toFixed(2)))) : current.ratio,
    };
    this.save();
    return this.state.autoCompact;
  }

  lastCompact() {
    return this.state.lastCompact ?? null;
  }

  setLastCompact(record) {
    this.state.lastCompact = sanitizeLastCompact(record);
    this.save();
    return this.state.lastCompact;
  }

  /** 继承链：从根（工作区默认）到目标项目。 */
  chain(id) {
    const out = [];
    const seen = new Set();
    let cursor = this.getProject(id) ?? this.getProject(DEFAULT_PROJECT_ID);
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      out.unshift(cursor);
      cursor = cursor.parentId ? this.getProject(cursor.parentId) : null;
    }
    return out;
  }

  /** 全局层：对所有项目生效的那一份配置。 */
  global() {
    return this.state.global ?? { caps: {}, sections: {}, tools: {} };
  }

  /** 合并后的能力开关（全局最弱，父级次之，项目自己最强）。 */
  capsFor(id) {
    const caps = { ...(this.global().caps ?? {}) };
    for (const project of this.chain(id)) Object.assign(caps, project.caps);
    return caps;
  }

  /** 合并后的系统提示段 / 系统工具规则（同样的层级顺序）。 */
  layersFor(id) {
    const sections = {};
    const tools = {};
    const scopes = [this.global(), ...this.chain(id)];
    for (const scope of scopes) {
      Object.assign(sections, scope?.sections ?? {});
      Object.assign(tools, scope?.tools ?? {});
    }
    return { sections, tools };
  }

  /** 项目（含继承）+ 会话覆盖后的段 / 工具规则：会话层最强。 */
  layersForSession(id, sessionId) {
    const { sections, tools } = this.layersFor(id);
    const entry = this.state.sessions?.[String(sessionId ?? "")];
    if (entry) {
      // 逐条深合并：会话只改 enabled 时，项目层的 text 改写仍然保留。
      for (const [name, rule] of Object.entries(entry.sections ?? {})) {
        sections[name] = { ...(sections[name] ?? {}), ...rule };
      }
      for (const [name, rule] of Object.entries(entry.tools ?? {})) {
        tools[name] = { ...(tools[name] ?? {}), ...rule };
      }
    }
    return { sections, tools };
  }

  /** 写一层规则：scopeId 传 "global" 或项目 id；patch 为 null 表示删掉覆盖。 */
  setScopeRule(scopeId, kind, key, patch) {
    if (kind !== "sections" && kind !== "tools") throw new Error(`未知的规则种类：${kind}`);
    if (typeof key !== "string" || !key.trim()) throw new Error("缺少名称");
    const scope = scopeId === "global" ? this.state.global : this.getProject(scopeId);
    if (!scope) throw new Error("项目不存在");
    const bucket = (scope[kind] ??= {});
    if (patch === null || patch === undefined) {
      delete bucket[key];
      this.save();
      return { key, rule: null };
    }
    const rule = { ...(bucket[key] ?? {}) };
    if (typeof patch.enabled === "boolean") rule.enabled = patch.enabled;
    if (typeof patch.text === "string") rule.text = patch.text.slice(0, MAX_TEXT);
    if (Object.keys(rule).length === 0) delete bucket[key];
    else bucket[key] = rule;
    this.save();
    return { key, rule: bucket[key] ?? null };
  }

  /** 一次性读某一层的规则（界面编辑用）。 */
  scopeRules(scopeId) {
    const scope = scopeId === "global" ? this.state.global : this.getProject(scopeId);
    if (!scope) return { caps: {}, sections: {}, tools: {} };
    return { caps: { ...(scope.caps ?? {}) }, sections: { ...(scope.sections ?? {}) }, tools: { ...(scope.tools ?? {}) } };
  }

  /** 会话 cwd 对应哪个项目：取 cwd 前缀匹配最长的一个，没匹配上就用工作区默认。 */
  projectForCwd(cwd) {
    const value = String(cwd ?? "").replace(/\/+$/, "");
    if (!value) return this.getProject(DEFAULT_PROJECT_ID);
    let winner = null;
    for (const project of this.state.projects) {
      if (!project.cwd) continue;
      const prefix = project.cwd.replace(/\/+$/, "");
      if (!prefix || !(value === prefix || value.startsWith(`${prefix}/`))) continue;
      if (!winner || prefix.length > winner.cwd.length) winner = project;
    }
    return winner ?? this.getProject(DEFAULT_PROJECT_ID);
  }

  createProject({ name, cwd, parentId, note } = {}) {
    const label = String(name ?? "").trim();
    if (!label) throw new Error("项目名不能为空");
    const parent = parentId ? this.getProject(parentId) : this.getProject(DEFAULT_PROJECT_ID);
    if (parentId && !parent) throw new Error("要继承的项目不存在");
    const project = {
      id: `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: label.slice(0, 60),
      cwd: String(cwd ?? "").trim().slice(0, 400),
      parentId: parent?.id ?? DEFAULT_PROJECT_ID,
      note: typeof note === "string" ? note.slice(0, 300) : "",
      builtin: false,
      caps: {},
    };
    this.state.projects.push(project);
    this.save();
    return project;
  }

  updateProject(id, patch = {}) {
    const project = this.getProject(id);
    if (!project) throw new Error("项目不存在");
    if ("name" in patch && project.auto !== true) {
      const label = String(patch.name ?? "").trim();
      if (!label) throw new Error("项目名不能为空");
      project.name = label.slice(0, 60);
    }
    if ("cwd" in patch && project.auto !== true) project.cwd = String(patch.cwd ?? "").trim().slice(0, 400);
    if ("note" in patch) project.note = String(patch.note ?? "").slice(0, 300);
    if ("parentId" in patch && project.id !== DEFAULT_PROJECT_ID) {
      const parentId = patch.parentId ? String(patch.parentId) : null;
      if (parentId === project.id) throw new Error("项目不能继承自己");
      if (parentId && !this.getProject(parentId)) throw new Error("要继承的项目不存在");
      // 断环：新父级不能是自己的后代。
      if (parentId) {
        const descendants = new Set();
        let cursor = this.getProject(parentId);
        while (cursor) {
          if (cursor.id === project.id) throw new Error("不能继承自己的子项目");
          if (descendants.has(cursor.id)) break;
          descendants.add(cursor.id);
          cursor = cursor.parentId ? this.getProject(cursor.parentId) : null;
        }
      }
      project.parentId = parentId;
    }
    this.save();
    return project;
  }

  removeProject(id) {
    const project = this.getProject(id);
    if (!project) throw new Error("项目不存在");
    if (project.id === DEFAULT_PROJECT_ID) throw new Error("「工作区默认」是继承链的根，不能删除");
    this.state.projects = this.state.projects.filter((item) => item.id !== id);
    // 子项目往上挂一层，别让它们变成孤儿。
    for (const item of this.state.projects) {
      if (item.parentId === id) item.parentId = project.parentId ?? DEFAULT_PROJECT_ID;
    }
    this.save();
    return project;
  }

  /** 改一个能力开关；enabled=null 表示删掉这条覆盖、回到继承来的值。 */
  setCap(projectId, key, enabled) {
    // projectId 传 "global" 就是改全局层。
    const project = projectId === "global" ? this.state.global : this.getProject(projectId ?? DEFAULT_PROJECT_ID);
    if (!project) throw new Error("项目不存在");
    const capKey = String(key ?? "").trim();
    if (!CAP_KEY.test(capKey)) throw new Error(`能力标识不合法：${capKey || "(空)"}`);
    const next = normalizeCapValue(enabled);
    project.caps ??= {};
    if (next === null) delete project.caps[capKey];
    else project.caps[capKey] = next;
    this.save();
    return project;
  }

  /** 会话级覆盖：胶囊里改的档位只作用于这一条会话。 */
  sessionCaps(sessionId) {
    const entry = this.state.sessions?.[String(sessionId ?? "")];
    return { ...(entry?.caps ?? {}) };
  }

  /** 会话级的段 / 工具规则（界面显示「本会话」标签用）。 */
  sessionRules(sessionId) {
    const entry = this.state.sessions?.[String(sessionId ?? "")];
    return { sections: { ...(entry?.sections ?? {}) }, tools: { ...(entry?.tools ?? {}) } };
  }

  setSessionCap(sessionId, key, enabled) {
    const id = String(sessionId ?? "").trim();
    if (!id) throw new Error("缺少会话 id");
    const capKey = String(key ?? "").trim();
    if (!CAP_KEY.test(capKey)) throw new Error(`能力标识不合法：${capKey || "(空)"}`);
    const next = normalizeCapValue(enabled);
    const sessions = (this.state.sessions ??= {});
    const entry = sessions[id] ?? { caps: {}, sections: {}, tools: {}, updatedAt: 0 };
    entry.caps ??= {};
    if (next === null) delete entry.caps[capKey];
    else entry.caps[capKey] = next;
    entry.updatedAt = Date.now();
    if (Object.keys(entry.caps).length === 0 && Object.keys(entry.sections ?? {}).length === 0 && Object.keys(entry.tools ?? {}).length === 0) delete sessions[id];
    else sessions[id] = entry;
    pruneSessions(sessions);
    this.save();
    return { ...(sessions[id]?.caps ?? {}) };
  }

  /** 写会话级的段 / 工具规则；patch 为 null 表示删掉覆盖。 */
  setSessionRule(sessionId, kind, key, patch) {
    const id = String(sessionId ?? "").trim();
    if (!id) throw new Error("缺少会话 id");
    if (kind !== "sections" && kind !== "tools") throw new Error(`未知的规则种类：${kind}`);
    if (typeof key !== "string" || !key.trim()) throw new Error("缺少名称");
    const sessions = (this.state.sessions ??= {});
    const entry = sessions[id] ?? { caps: {}, sections: {}, tools: {}, updatedAt: 0 };
    const bucket = (entry[kind] ??= {});
    if (patch === null || patch === undefined) {
      delete bucket[key];
      entry.updatedAt = Date.now();
      if (Object.keys(entry.caps ?? {}).length === 0 && Object.keys(entry.sections ?? {}).length === 0 && Object.keys(entry.tools ?? {}).length === 0) delete sessions[id];
      else sessions[id] = entry;
      pruneSessions(sessions);
      this.save();
      return { key, rule: null };
    }
    const rule = { ...(bucket[key] ?? {}) };
    if (typeof patch.enabled === "boolean") rule.enabled = patch.enabled;
    if (typeof patch.text === "string") rule.text = patch.text.slice(0, MAX_TEXT);
    if (Object.keys(rule).length === 0) delete bucket[key];
    else bucket[key] = rule;
    entry.updatedAt = Date.now();
    sessions[id] = entry;
    pruneSessions(sessions);
    this.save();
    return { key, rule: bucket[key] ?? null };
  }

  /**
   * 把 DSH 已注册的工作区同步成项目：不用手动新增，面板里直接就能看到。
   * 同步来的项目 id 固定为 `ws:<workspaceId>`，所以能力开关跟着工作区走，不会因为改名丢配置。
   * 目录不在注册表里时只标记 missing，不删记录——开关留着，工作区回来还能用。
   */
  syncWorkspaces(workspaces = [], { authoritative = true } = {}) {
    let changed = false;
    const seen = new Set();
    for (const workspace of workspaces) {
      const wsId = String(workspace?.id ?? "").trim();
      const dir = String(workspace?.path ?? "").trim();
      if (!wsId || !dir) continue;
      const id = `ws:${wsId}`;
      seen.add(id);
      const title = String(workspace?.title ?? "").trim();
      let project = this.getProject(id);
      if (!project) {
        project = {
          id,
          name: title || dir.split("/").filter(Boolean).at(-1) || dir,
          cwd: dir,
          parentId: DEFAULT_PROJECT_ID,
          note: "自动同步自 DSH 工作区",
          builtin: false,
          auto: true,
          workspaceId: wsId,
          caps: {},
        };
        this.state.projects.push(project);
        changed = true;
        continue;
      }
      if (project.auto !== true) continue;
      if (title && project.name !== title) {
        project.name = title;
        changed = true;
      }
      if (project.cwd !== dir) {
        project.cwd = dir;
        changed = true;
      }
      if (project.workspaceId !== wsId) {
        project.workspaceId = wsId;
        changed = true;
      }
      if (project.missing) {
        delete project.missing;
        changed = true;
      }
    }
    if (authoritative) {
      for (const project of this.state.projects) {
        if (project.auto !== true) continue;
        const missing = !seen.has(project.id);
        if (Boolean(project.missing) !== missing) {
          project.missing = missing;
          changed = true;
        }
      }
    }
    if (changed) this.save();
    return changed;
  }

  /** 面板里点开关时项目可能还没同步进来（新工作区刚建），这里补一条最小记录。 */
  ensureProject({ id, name, cwd, parentId } = {}) {
    const key = String(id ?? "").trim();
    const existed = key ? this.getProject(key) : null;
    if (existed) return existed;
    if (!key) return this.getProject(DEFAULT_PROJECT_ID);
    const project = {
      id: key,
      name: String(name ?? key).slice(0, 60),
      cwd: String(cwd ?? "").trim().slice(0, 400),
      parentId: parentId && this.getProject(parentId) ? parentId : DEFAULT_PROJECT_ID,
      note: "",
      builtin: false,
      auto: key.startsWith("ws:"),
      caps: {},
    };
    this.state.projects.push(project);
    this.save();
    return project;
  }

  /** 批量改能力开关（一键全开 / 全关 / 按分组）：enabled=null 表示统一回到继承值。 */
  setCaps(projectId, keys, enabled) {
    // projectId 传 "global" 就是改全局层。
    const project = projectId === "global" ? this.state.global : this.getProject(projectId ?? DEFAULT_PROJECT_ID);
    if (!project) throw new Error("项目不存在");
    project.caps ??= {};
    let touched = 0;
    for (const key of keys ?? []) {
      const capKey = String(key ?? "").trim();
      if (!CAP_KEY.test(capKey)) continue;
      const next = normalizeCapValue(enabled);
      if (next === null) {
        if (capKey in project.caps) {
          delete project.caps[capKey];
          touched += 1;
        }
        continue;
      }
      if (project.caps[capKey] !== next) {
        project.caps[capKey] = next;
        touched += 1;
      }
    }
    if (touched > 0) this.save();
    return touched;
  }

  /** 改指定模式的规则；parts 页只允许改当前 active mode。 */
  setRuleForMode(modeId, kind, key, patch = {}) {
    if (!RULE_KINDS.includes(kind)) throw new Error(`未知的规则类型：${kind}`);
    const mode = this.get(modeId);
    if (!mode) throw new Error("模式不存在");
    if (mode.id !== this.activeModeId) throw new Error("只能编辑当前模式");
    const name = String(key ?? "").trim();
    if (!name) throw new Error("模块名不能为空");
    const table = mode.rules[kind];
    const current = { ...(table[name] ?? {}) };

    if ("enabled" in patch) {
      if (patch.enabled === null) delete current.enabled;
      else current.enabled = patch.enabled !== false;
    }
    if ("text" in patch) {
      if (patch.text === null) delete current.text;
      else current.text = String(patch.text ?? "").slice(0, MAX_TEXT);
    }

    if (Object.keys(current).length === 0) delete table[name];
    else table[name] = current;
    this.save();
    return mode;
  }

  /** 兼容旧调用：默认改当前 active mode。 */
  setRule(kind, key, patch = {}) {
    return this.setRuleForMode(this.active().id, kind, key, patch);
  }
}

/** 规则表的统计：给界面显示「关掉了几项 / 改写了几项」。 */
export function ruleStats(rules) {
  const stats = { disabled: 0, edited: 0, total: 0 };
  for (const kind of RULE_KINDS) {
    for (const rule of Object.values(rules?.[kind] ?? {})) {
      stats.total += 1;
      if (rule?.enabled === false) stats.disabled += 1;
      if (typeof rule?.text === "string") stats.edited += 1;
    }
  }
  return stats;
}

/** applyOps 的纯函数版：只改传入的 state 副本，不碰磁盘。 */
function applyOpToState(state, op) {
  const action = String(op?.op ?? "");
  if (!action) throw new Error("缺少操作类型");
  if (action === "setCap") {
    const scope = op.scopeId === "global" ? state.global : state.projects.find((item) => item.id === op.scopeId);
    if (!scope) throw new Error("项目不存在");
    const key = String(op.key ?? "").trim();
    if (!CAP_KEY.test(key)) throw new Error(`能力标识不合法：${key || "(空)"}`);
    const next = normalizeCapValue(op.value ?? op.enabled);
    scope.caps ??= {};
    if (next === null) delete scope.caps[key];
    else scope.caps[key] = next;
    return;
  }
  if (action === "setScopeRule") {
    if (op.kind !== "sections" && op.kind !== "tools") throw new Error(`未知的规则种类：${op.kind}`);
    const scope = op.scopeId === "global" ? state.global : state.projects.find((item) => item.id === op.scopeId);
    if (!scope) throw new Error("项目不存在");
    const kind = op.kind;
    const key = String(op.key ?? "").trim();
    if (!key) throw new Error("缺少名称");
    scope[kind] ??= {};
    applyRulePatch(scope[kind], key, op.patch);
    return;
  }
  if (action === "setSessionCap") {
    const id = String(op.sessionId ?? "").trim();
    if (!id) throw new Error("缺少会话 id");
    const key = String(op.key ?? "").trim();
    if (!CAP_KEY.test(key)) throw new Error(`能力标识不合法：${key || "(空)"}`);
    const sessions = (state.sessions ??= {});
    const entry = sessions[id] ?? { caps: {}, sections: {}, tools: {}, updatedAt: 0 };
    entry.caps ??= {};
    const next = normalizeCapValue(op.value ?? op.enabled);
    if (next === null) delete entry.caps[key];
    else entry.caps[key] = next;
    entry.updatedAt = Date.now();
    if (!sessionHasRules(entry)) delete sessions[id];
    else sessions[id] = entry;
    pruneSessions(sessions);
    return;
  }
  if (action === "setSessionRule") {
    if (op.kind !== "sections" && op.kind !== "tools") throw new Error(`未知的规则种类：${op.kind}`);
    const id = String(op.sessionId ?? "").trim();
    if (!id) throw new Error("缺少会话 id");
    const key = String(op.key ?? "").trim();
    if (!key) throw new Error("缺少名称");
    const sessions = (state.sessions ??= {});
    const entry = sessions[id] ?? { caps: {}, sections: {}, tools: {}, updatedAt: 0 };
    entry[op.kind] ??= {};
    applyRulePatch(entry[op.kind], key, op.patch);
    entry.updatedAt = Date.now();
    if (!sessionHasRules(entry)) delete sessions[id];
    else sessions[id] = entry;
    pruneSessions(sessions);
    return;
  }
  if (action === "setRule") {
    if (!RULE_KINDS.includes(op.kind)) throw new Error(`未知的规则类型：${op.kind}`);
    const mode = state.modes.find((item) => item.id === op.modeId);
    if (!mode) throw new Error("模式不存在");
    if (mode.id !== state.activeModeId) throw new Error("只能编辑当前模式");
    const key = String(op.key ?? "").trim();
    if (!key) throw new Error("模块名不能为空");
    applyRulePatch(mode.rules[op.kind], key, op.patch);
    return;
  }
  throw new Error(`未知的操作类型：${action}`);
}

function applyRulePatch(table, key, patch) {
  if (patch === null || patch === undefined) {
    delete table[key];
    return;
  }
  const current = { ...(table[key] ?? {}) };
  if ("enabled" in patch) {
    if (patch.enabled === null) delete current.enabled;
    else current.enabled = patch.enabled !== false;
  }
  if ("text" in patch) {
    if (patch.text === null) delete current.text;
    else current.text = String(patch.text ?? "").slice(0, MAX_TEXT);
  }
  if (Object.keys(current).length === 0) delete table[key];
  else table[key] = current;
}

function sessionHasRules(entry) {
  return Object.keys(entry.caps ?? {}).length > 0 || Object.keys(entry.sections ?? {}).length > 0 || Object.keys(entry.tools ?? {}).length > 0;
}
