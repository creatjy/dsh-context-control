/**
 * dsh-context-control —— 浏览器侧。
 *
 * 三个入口：
 *   1. 左侧栏图标 → main 面板：模式管理 + 按模块看 token + 逐项开关/编辑。
 *   2. 输入框左侧的小胶囊 → 点开一层浮层：看本会话每块占用、勾选要压缩的模块，
 *      把压缩提示词写进输入框（默认不直接发送）；技能 / MCP / 插件的开关也收在这里。
 *   3. shell.overlay：承接上面这层浮层（浮在 body 层，不受输入框容器的裁剪影响）。
 */
window.__ModuleLoader__.load({
  id: "dsh-context-control",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef } = react;

    const API = "/dsh-context-control/api";

    const GROUP_LABELS = {
      system: "系统内容",
      skills: "技能",
      tools: "工具说明",
      inject: "注入",
      contexts: "运行时注入",
    };

    /* ---------------------------------------------------------------- 数据 */

    async function request(payload, query) {
      const params = query ? `?${new URLSearchParams(query).toString()}` : "";
      const init = payload
        ? {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }
        : { credentials: "same-origin", cache: "no-store" };
      const response = await fetch(`${API}${params}`, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data && data.ok === false) throw new Error(data.error || "请求失败");
      return data;
    }

    function messageOf(error) {
      if (!error) return "";
      return error instanceof Error ? error.message : String(error);
    }

    function formatTokens(tokens) {
      const value = Math.max(0, Math.round(Number(tokens) || 0));
      if (value < 1000) return String(value);
      if (value < 100000) return `${(value / 1000).toFixed(1)}k`;
      return `${Math.round(value / 1000)}k`;
    }

    /** 一次压缩结果的一句话版本（折叠多少、窗口从哪到哪、少了多少）。 */
    function compactSummary(info) {
      if (!info || info.running || info.queued || info.error || !info.compacted) return "";
      const before = info.beforeSurface ?? 0;
      const after = info.afterSurface ?? 0;
      const saved = Math.max(0, before - after);
      return `上次压缩：折叠 ${formatTokens(info.shadowedTokens ?? 0)} tokens，窗口 ${formatTokens(before)} → ${formatTokens(after)}（少 ${formatTokens(saved)}）` +
        (info.why === "auto" ? "，自动触发" : "");
    }

    function timeOf(at) {
      try {
        return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      } catch {
        return "";
      }
    }

    /* --------------------------------------------------- 会话内弹窗的小状态机 */

    const overlay = {
      open: false,
      sessionId: null,
      input: null,
      rect: null,
      listeners: new Set(),
      set(patch) {
        Object.assign(this, patch);
        for (const listener of [...this.listeners]) listener();
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };

    function useOverlay() {
      const read = () => ({
        open: overlay.open,
        sessionId: overlay.sessionId,
        input: overlay.input,
        rect: overlay.rect,
      });
      const [snapshot, setSnapshot] = useState(read);
      useEffect(() => {
        setSnapshot(read());
        return overlay.subscribe(() => setSnapshot(read()));
      }, []);
      return snapshot;
    }

    /* ------------------------------------------------------------ 基础组件 */

    function Switch({ checked, onChange, disabled, title }) {
      return h(
        "button",
        {
          type: "button",
          className: `cc-switch${checked ? " is-on" : ""}`,
          role: "switch",
          "aria-checked": checked ? "true" : "false",
          title: title || (checked ? "已加载：点击停用" : "已停用：点击加载"),
          disabled: Boolean(disabled),
          onClick: (event) => {
            event.stopPropagation();
            onChange?.(!checked);
          },
        },
        h("span", { className: "cc-switch-dot" }),
      );
    }

    const FILTER_STATUS = [
      { value: "all", label: "全部状态" },
      { value: "on", label: "已开启" },
      { value: "off", label: "已关闭" },
    ];

    function statusMatches(status, on) {
      return status === "all" || (status === "on" ? on : !on);
    }

    /** 所有筛选框共用的状态筛选：和文本搜索叠加，按「实际是否生效」过滤。 */
    function StatusFilter({ value, onChange, busy, className }) {
      return h(
        "select",
        {
          className: `cc-select cc-status-select${className ? ` ${className}` : ""}`,
          value,
          disabled: Boolean(busy),
          "aria-label": "按状态筛选",
          title: "按开启状态筛选",
          onChange: (event) => onChange(event.target.value),
        },
        FILTER_STATUS.map((item) => h("option", { key: item.value, value: item.value }, item.label)),
      );
    }

    /** 横向切换条：构成/项目里的子集用它，和会话胶囊同一种交互。 */
    function SubTabs({ items, value, onChange, busy, level }) {
      return h(
        "div",
        { className: "cc-subtabs" + (level === "secondary" ? " is-secondary" : ""), role: "tablist" },
        items.map((item) =>
          h(
            "button",
            {
              key: item.key,
              type: "button",
              role: "tab",
              "aria-selected": value === item.key ? "true" : "false",
              className: `cc-subtab${level === "secondary" ? " is-sub" : ""}${value === item.key ? " is-active" : ""}`,
              disabled: Boolean(busy),
              onClick: () => onChange(item.key),
            },
            item.label,
            item.badge ? h("span", { className: "cc-subtab-badge" }, item.badge) : null,
            item.note ? h("span", { className: "cc-subtab-note" }, item.note) : null,
            item.minus ? h("span", { className: "cc-subtab-minus" }, item.minus) : null,
          ),
        ),
      );
    }

    function Token({ tokens, muted }) {
      return h("span", { className: `cc-token${muted ? " is-muted" : ""}` }, `≈${formatTokens(tokens)}`);
    }

    function Bar({ ratio, tone }) {
      const width = Math.max(0, Math.min(1, Number(ratio) || 0));
      return h(
        "div",
        { className: "cc-bar" },
        h("span", { className: `cc-bar-fill${tone ? ` is-${tone}` : ""}`, style: { width: `${width * 100}%` } }),
      );
    }

    function Editor({ title, value, hint, onSave, onCancel, busy }) {
      const [draft, setDraft] = useState(value ?? "");
      return h(
        "div",
        { className: "cc-editor" },
        h("div", { className: "cc-editor-head" },
          h("strong", null, title),
          h("span", { className: "cc-muted" }, hint || "改完点保存：只影响本模式的这个模块"),
        ),
        h("textarea", {
          className: "cc-textarea",
          value: draft,
          spellCheck: false,
          onChange: (event) => setDraft(event.target.value),
        }),
        h("div", { className: "cc-editor-foot" },
          h("span", { className: "cc-muted" }, `${draft.length} 字符 · ≈${formatTokens(estimateLocal(draft))} tokens`),
          h("div", { className: "cc-row-gap" },
            h("button", { type: "button", className: "cc-btn", disabled: busy, onClick: onCancel }, "取消"),
            h("button", { type: "button", className: "cc-btn is-primary", disabled: busy, onClick: () => onSave(draft) }, "保存"),
          ),
        ),
      );
    }

    /** 客户端也估一下，编辑器里能实时看到改动后的体量（口径与宿主一致）。 */
    function estimateLocal(text) {
      if (!text) return 0;
      let cjk = 0;
      let other = 0;
      for (const ch of String(text)) {
        const cp = ch.codePointAt(0) || 0;
        if (cp >= 0x2e80) cjk += 1;
        else other += 1;
      }
      return Math.round(cjk + other / 3.6);
    }

    /* --------------------------------------------------------------- 左栏图标 */

    function Icon({ size, active }) {
      const edge = typeof size === "number" && size > 0 ? size : 20;
      return h(
        "svg",
        {
          width: edge,
          height: edge,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: active ? 1.9 : 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          style: { display: "block" },
        },
        h("path", { d: "M12 3 3 7.5 12 12l9-4.5L12 3Z" }),
        h("path", { d: "M3 12.2 12 16.7l9-4.5", opacity: active ? 0.85 : 0.6 }),
        h("path", { d: "M3 16.7 12 21.2l9-4.5", opacity: active ? 0.7 : 0.35 }),
      );
    }

    /* ---------------------------------------------------------- 模块行（可开关/编辑） */

    function ModuleRow({ item, rule, busy, onToggle, onEdit, onReset }) {
      const enabled = rule?.enabled !== false;
      const edited = typeof rule?.text === "string";
      return h(
        "div",
        { className: `cc-row${enabled ? "" : " is-off"}` },
        h(Switch, { checked: enabled, disabled: busy, onChange: onToggle }),
        h(
          "div",
          { className: "cc-row-main" },
          h(
            "div",
            { className: "cc-row-title" },
            h("code", { className: "cc-name" }, item.name),
            edited ? h("span", { className: "cc-tag" }, "已改写") : null,
            !enabled ? h("span", { className: "cc-tag is-off" }, "不加载") : null,
          ),
          item.preview ? h("div", { className: "cc-row-preview" }, item.preview) : null,
        ),
        h(Token, { tokens: item.tokens, muted: !enabled }),
        h(
          "div",
          { className: "cc-row-actions" },
          h("button", { type: "button", className: "cc-btn is-ghost", disabled: busy, onClick: onEdit }, "编辑"),
          edited
            ? h("button", { type: "button", className: "cc-btn is-ghost", disabled: busy, onClick: onReset }, "还原")
            : null,
        ),
      );
    }

    /* ------------------------------------------- 项目能力（技能 / MCP / 插件） */

    /* ---- 三档：完整加载 / 只留简介 / 完全不显示 ---- */

    const CAP_MODES = [
      { value: "on", label: "加载", hint: "完整发送：正文、工具都在" },
      { value: "brief", label: "简介", hint: "不发送正文，只留一行简介；被调用时自动恢复，不用确认" },
      { value: "hidden", label: "隐藏", hint: "连简介都不发；被调用时先征求你同意" },
    ];

    function modeOfCaps(caps, key) {
      if (caps[key] === "hidden") return "hidden";
      if (caps[key] === false) return "brief";
      return "on";
    }

    function valueForMode(mode) {
      return mode === "hidden" ? "hidden" : mode === "brief" ? false : true;
    }

    /**
     * 数字跟着档位走：加载 = 全量，简介 = 那一行摘要的估算，隐藏 = 0。
     * 界面上「这一档要花多少」必须能直接比较，所以不在旁边另标原值。
     */
    function tokenForMode(entry, mode) {
      if (mode === "hidden") return 0;
      if (mode === "brief") {
        const line = `- ${entry.id}：${entry.summary ?? ""}`;
        return Math.min(entry.tokens ?? 0, Math.ceil(line.length / 3) + 8);
      }
      return entry.tokens ?? 0;
    }

    function CapSeg({ mode, busy, onSet }) {
      return h(
        "div",
        { className: "cc-seg", role: "group", "aria-label": "加载档位" },
        CAP_MODES.map((item) =>
          h(
            "button",
            {
              key: item.value,
              type: "button",
              className: `cc-seg-btn is-${item.value}${mode === item.value ? " is-active" : ""}`,
              title: item.hint,
              disabled: busy,
              onClick: () => onSet(valueForMode(item.value)),
            },
            item.label,
          ),
        ),
      );
    }

    function CapRow({ entry, mode, own, busy, scopeLabel, onSet, onReset }) {
      const readOnly = entry.readOnly === true;
      return h(
        "div",
        { className: `cc-cap is-${mode}${readOnly ? " is-readonly" : ""}` },
        h(
          "div",
          { className: "cc-cap-main" },
          h(
            "div",
            { className: "cc-cap-title" },
            h("span", { className: "cc-cap-name", title: entry.key }, entry.id),
            own ? h("span", { className: "cc-tag" }, scopeLabel ?? "本项目") : null,
          ),
          entry.summary ? h("div", { className: "cc-cap-sum", title: entry.summary }, entry.summary) : null,
        ),
        h(
          "span",
          { className: "cc-num", title: `当前档位实际发送 ≈${formatTokens(tokenForMode(entry, mode))} / 全量 ≈${formatTokens(entry.tokens ?? 0)}` },
          `≈${formatTokens(tokenForMode(entry, mode))}`,
        ),
        readOnly
          ? h("span", {
              className: "cc-seg is-readonly",
              title: "来自磁盘技能目录的只读条目；没有可写的目录段，不能在这里开关",
            }, "只读")
          : h(CapSeg, { mode, busy, onSet }),
        readOnly
          ? h("span", { className: "cc-link is-muted", title: "来自磁盘技能目录" }, "磁盘")
          : own
            ? h("button", {
                type: "button",
                className: "cc-link",
                disabled: busy,
                title: "撤掉本项目的覆盖，回到继承来的档位",
                onClick: onReset,
              }, "继承")
            : h("span", { className: "cc-link is-muted", title: "沿用父项目" }, "继承"),
      );
    }

    function CapGroup({ entries, caps, busy, scopeLabel, onSet, onReset, onAll, bare, hint, emptyText }) {
      const modes = entries.map((entry) => modeOfCaps(caps, entry.key));
      const brief = modes.filter((mode) => mode === "brief").length;
      const hidden = modes.filter((mode) => mode === "hidden").length;
      const on = entries.length - brief - hidden;
      const readOnly = entries.filter((entry) => entry.readOnly === true).length;
      const canBulk = entries.some((entry) => entry.readOnly !== true);
      const tokens = entries.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
      const offTokens = entries.reduce(
        (sum, entry) => sum + (modeOfCaps(caps, entry.key) === "on" ? 0 : entry.tokens ?? 0),
        0,
      );
      const actions = h(
        "span",
        { className: "cc-cap-actions" },
        h("button", {
          type: "button",
          className: "cc-btn is-mini",
          disabled: busy || !canBulk,
          title: canBulk ? undefined : "只读技能没有可写的目录段",
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            onAll(true);
          },
        }, "全开"),
        h("button", {
          type: "button",
          className: "cc-btn is-mini",
          disabled: busy || !canBulk,
          title: canBulk ? undefined : "只读技能没有可写的目录段",
          onClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            onAll(false);
          },
        }, "全关"),
      );
      const pills = brief || hidden || readOnly || offTokens
        ? h(
            "span",
            { className: "cc-pills" },
            brief ? h("span", { className: "cc-pill is-brief" }, `简介 ${brief}`) : null,
            hidden ? h("span", { className: "cc-pill is-hidden" }, `隐藏 ${hidden}`) : null,
            readOnly ? h("span", { className: "cc-pill" }, `只读 ${readOnly}`) : null,
            offTokens ? h("span", { className: "cc-pill" }, `少发 ≈${formatTokens(offTokens)}`) : null,
          )
        : null;
      const list = entries.length === 0
        ? h("div", { className: "cc-empty is-small" }, emptyText || "这一组还没有条目。")
        : h(
            "div",
            { className: "cc-cap-list" },
            entries.map((entry) =>
              h(CapRow, {
                key: entry.key,
                entry,
                mode: modeOfCaps(caps, entry.key),
                scopeLabel,
                own: Object.prototype.hasOwnProperty.call(caps.__own ?? {}, entry.key),
                busy,
                onSet: (value) => onSet(entry.key, value),
                onReset: () => onReset(entry.key),
              }),
            ),
          );

      if (bare) {
        return h(
          "div",
          null,
          h(
            "div",
            { className: "cc-toolbar" },
            h("span", { className: "cc-count is-static" }, `${on}/${entries.length} 已加载 · ≈${formatTokens(tokens)}`),
            pills,
            h("span", { style: { marginLeft: "auto" } }, actions),
          ),
          hint ? h("p", { className: "cc-hint is-tight" }, hint) : null,
          list,
        );
      }

      return h(
        "details",
        { className: "cc-capgroup", open: true },
        h(
          "summary",
          null,
          h("span", { className: "cc-h3" }, title),
          h("span", { className: "cc-count is-static" }, `${on}/${entries.length} 已加载 · ≈${formatTokens(tokens)}`),
          pills,
          actions,
        ),
        hint ? h("p", { className: "cc-hint" }, hint) : null,
        list,
      );
    }

    const CAP_GROUPS = [
      { key: "skills", title: "技能", hint: "目录里的一行摘要；关掉即从目录里删行，懒加载时也会拦一下" },
      { key: "mcp", title: "MCP 服务", hint: "整组工具 + 说明段，按服务整体开关" },
      { key: "plugins", title: "插件", hint: "插件注册的说明段与工具" },
    ];
    const SKILL_EMPTY_TEXT = "没有检测到技能目录段，也没有在磁盘技能目录里找到技能。安装或启用懒工具箱后，这里会变成可调列表。";

    /**
     * 某一层（全局 / 某个项目）对系统提示段或系统工具的规则。
     * 列表来自实时装配，规则来自这一层自己的覆盖表，所以「继承来的」和「我改过的」能分清。
     */
    function ScopeRules({ state, busy, act, scopeId, kind }) {
      const [editing, setEditing] = useState(null);
      const all = kind === "sections" ? state.prompt?.sections ?? [] : state.prompt?.tools ?? [];
      const own = useMemo(() => {
        if (scopeId === "global") return state.global?.[kind] ?? {};
        return (state.projects ?? []).find((item) => item.id === scopeId)?.[kind] ?? {};
      }, [state, scopeId, kind]);
      const merged = useMemo(() => {
        if (scopeId === "global") return state.global?.[kind] ?? {};
        return (state.projects ?? []).find((item) => item.id === scopeId)?.resolved?.[kind] ?? {};
      }, [state, scopeId, kind]);
      const set = (name, patch) => void act({ action: "setScopeRule", scopeId, kind, name, patch });
      // 这一层只管「本项目自己的覆盖」，但工具还可能被上一层的 MCP / 插件能力整组关掉。
      // 不标出来的话，页面上 158 个工具全显示「开」，看着像开关没生效。
      const scopeCaps = useMemo(() => {
        if (scopeId === "global") return state.global?.caps ?? {};
        return (state.projects ?? []).find((item) => item.id === scopeId)?.resolvedCaps ?? {};
      }, [state, scopeId]);
      const [query, setQuery] = useState("");
      const [status, setStatus] = useState("all");
      const base = all.filter((item) => kind === "tools" || item.tokens > 0 || own[item.name]);
      const itemOn = (item) => {
        const rule = own[item.name] ?? {};
        const enabled = (own[item.name] ? rule.enabled : merged[item.name]?.enabled) !== false;
        const capMode = kind === "tools" && item.capKey ? modeOfCaps(scopeCaps, item.capKey) : "on";
        return enabled && capMode === "on";
      };
      const needle = query.trim().toLowerCase();
      const searched = needle
        ? base.filter((item) => item.name.toLowerCase().includes(needle) || (item.preview ?? "").toLowerCase().includes(needle))
        : base;
      const items = searched.filter((item) => statusMatches(status, itemOn(item)));

      if (base.length === 0) {
        return h("div", { className: "cc-empty is-small" }, kind === "sections" ? "还没有可读的系统提示段。" : "工具表还没读出来。");
      }
      return h(
        "div",
        { className: "cc-list" },
        h(
          "div",
          { className: "cc-toolbar", key: "__toolbar" },
          h("input", {
            className: "cc-input",
            type: "search",
            value: query,
            placeholder: kind === "sections" ? "按段名筛选…" : "按工具名筛选…",
            "aria-label": "筛选",
            onChange: (event) => setQuery(event.target.value),
          }),
          h(StatusFilter, { value: status, onChange: setStatus, busy }),
          h("span", { className: "cc-muted" }, `${items.length}/${base.length} 项`),
        ),
        items.length === 0 ? h("div", { className: "cc-empty is-small" }, "没有匹配的条目。") : null,
        items.map((item) => {
          const rule = own[item.name] ?? {};
          const enabled = (own[item.name] ? rule.enabled : merged[item.name]?.enabled) !== false;
          const capMode = kind === "tools" && item.capKey ? modeOfCaps(scopeCaps, item.capKey) : "on";
          const capOff = capMode !== "on";
          const shown = rule.text ?? merged[item.name]?.text ?? item.text ?? "";
          const tokens = item.tokens ?? 0;
          return editing === item.name && kind === "sections"
            ? h(Editor, {
                key: `${item.name}-scope-edit`,
                title: `编辑 · ${item.name}`,
                value: shown,
                busy,
                onCancel: () => setEditing(null),
                onSave: async (text) => {
                  await act({ action: "setScopeRule", scopeId, kind, name: item.name, patch: { text } });
                  setEditing(null);
                },
              })
            : h(
                "div",
                { key: item.name, className: `cc-row${enabled && !capOff ? "" : " is-off"}`, title: capOff ? `所属能力 ${item.capKey} 被关闭` : undefined },
                h(Switch, {
                  checked: enabled && !capOff,
                  disabled: busy || capOff,
                  title: capOff ? `所属能力 ${item.capKey} 被关闭，先在上方能力页打开` : undefined,
                  onChange: (next) => set(item.name, { enabled: next }),
                }),
                h(
                  "div",
                  { className: "cc-row-main" },
                  h(
                    "div",
                    { className: "cc-row-title" },
                    h("code", { className: "cc-name" }, item.name),
                    capOff ? h("span", { className: `cc-tag is-${capMode}` }, capMode === "hidden" ? "隐藏" : "简介") : null,
                    own[item.name] ? h("span", { className: "cc-tag" }, scopeId === "global" ? "全局" : "本项目") : null,
                    rule.text ? h("span", { className: "cc-tag" }, "已改写") : null,
                  ),
                  h("div", { className: "cc-row-preview" }, item.preview || (item.description ?? "") || "（空）"),
                ),
                h("span", { className: "cc-num" }, `≈${formatTokens(enabled ? tokens : 0)}`),
                h(
                  "div",
                  { className: "cc-row-actions" },
                  kind === "sections"
                    ? h("button", {
                        type: "button",
                        className: "cc-link",
                        disabled: busy,
                        onClick: () => setEditing(item.name),
                      }, "编辑")
                    : null,
                  own[item.name]
                    ? h("button", {
                        type: "button",
                        className: "cc-link is-muted",
                        disabled: busy,
                        onClick: () => set(item.name, null),
                      }, "还原")
                    : h("span", { className: "cc-link is-muted" }, "继承"),
                ),
              );
        }),
      );
    }

    function ProjectCaps({ state, busy, act, scopeId: fixedScope }) {
      const [projectId, setProjectId] = useState("");
      const [newName, setNewName] = useState("");
      const [newCwd, setNewCwd] = useState("");
      const [view, setView] = useState("skills");
      const [capQuery, setCapQuery] = useState("");
      const [capStatus, setCapStatus] = useState("all");

      const projects = state.projects ?? [];
      const isGlobal = fixedScope === "global";
      const globalCaps = state.global?.caps ?? {};
      const selected = isGlobal
        ? {
            id: "global",
            name: "全局管控",
            builtin: true,
            auto: false,
            missing: false,
            matched: false,
            chain: [],
            caps: globalCaps,
            resolvedCaps: globalCaps,
            sections: state.global?.sections ?? {},
            tools: state.global?.tools ?? {},
            resolved: { sections: state.global?.sections ?? {}, tools: state.global?.tools ?? {} },
          }
        : projects.find((item) => item.id === projectId) ??
          projects.find((item) => item.id === state.activeProjectId) ??
          projects[0] ??
          null;

      const caps = useMemo(() => {
        const merged = { ...(selected?.resolvedCaps ?? {}) };
        // 只用于判断「这条是不是本项目自己写的覆盖」。
        Object.defineProperty(merged, "__own", { value: selected?.caps ?? {}, enumerable: false });
        return merged;
      }, [selected]);

      if (!selected) {
        return h("div", { className: "cc-empty" }, "还没有项目。先在上面新建一个，或者让工作区同步一次。");
      }

      const catalog = state.capabilities ?? { skills: [], mcp: [], plugins: [] };
      const allEntries = [...catalog.skills, ...catalog.mcp, ...catalog.plugins];
      const buckets = { on: [], brief: [], hidden: [] };
      for (const entry of allEntries) buckets[modeOfCaps(caps, entry.key)].push(entry);
      const sumTokens = (list) => list.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
      const savedTokens = sumTokens(buckets.brief) + sumTokens(buckets.hidden);
      const offCount = buckets.brief.length + buckets.hidden.length;

      const scopeSectionCount = (state.prompt?.sections ?? []).filter((item) => item.tokens > 0).length;
      const scopeToolCount = (state.prompt?.tools ?? []).length;
      const scopeCapsFor = (scope) => (scope === "global" ? state.global?.caps ?? {} : selected.resolvedCaps ?? {});
      const scopeCapOff = (scope, kind, item) => {
        if (kind !== "tools" || !item.capKey) return false;
        const caps = scopeCapsFor(scope);
        return modeOfCaps(caps, item.capKey) !== "on";
      };
      const scopeTokens = (kind, scope) => {
        const merged = selected.resolved?.[kind] ?? {};
        const ownRules = selected[kind] ?? {};
        return (kind === "sections" ? state.prompt?.sections ?? [] : state.prompt?.tools ?? []).reduce((sum, item) => {
          const rule = ownRules[item.name] ?? merged[item.name] ?? {};
          if (rule.enabled === false) return sum;
          if (scopeCapOff(scope, kind, item)) return sum;
          return sum + (item.tokens ?? 0);
        }, 0);
      };
      const scopeLoadedCount = (kind, scope) => {
        const merged = selected.resolved?.[kind] ?? {};
        const ownRules = selected[kind] ?? {};
        return (kind === "sections" ? state.prompt?.sections ?? [] : state.prompt?.tools ?? []).filter((item) => {
          const rule = ownRules[item.name] ?? merged[item.name] ?? {};
          if (rule.enabled === false) return false;
          return !scopeCapOff(scope, kind, item);
        }).length;
      };
      const scopeSectionTokens = scopeTokens("sections", "local");
      const scopeSectionLoaded = scopeLoadedCount("sections", "local");
      const scopeStats = (kind) => {
        const items = kind === "sections" ? state.prompt?.sections ?? [] : state.prompt?.tools ?? [];
        const rules = selected.resolved?.[kind] ?? {};
        let loaded = 0, full = 0, off = 0, offT = 0;
        for (const item of items) {
          const t = item.tokens ?? 0;
          full += t;
          const capDown = kind === "tools" && item.capKey
            ? modeOfCaps(scopeCapsFor(isGlobal ? "global" : "local"), item.capKey) !== "on"
            : false;
          if (rules[item.name]?.enabled === false || capDown) { off += 1; offT += t; } else loaded += t;
        }
        return { loaded, full, off, offT };
      };
      const scopeToolTokens = scopeTokens("tools", isGlobal ? "global" : "local");
      const scopeToolLoaded = scopeLoadedCount("tools", isGlobal ? "global" : "local");

      const set = (key, value) => void act({ action: "setCap", projectId: selected.id, key, enabled: value });
      const reset = (key) => void act({ action: "setCap", projectId: selected.id, key, enabled: null });
      const saveField = (patch) => void act({ action: "updateProject", id: selected.id, patch });
      const parentOptions = projects.filter(
        (item) => item.id !== selected.id && !(selected.chain ?? []).includes(item.id),
      );
      // 全局页写全局层（各项目继承）；项目页写所有项目自己的覆盖。
      const bulkAll = (enabled) => void act({ action: "setCaps", projectId: isGlobal ? "global" : "*", group: "all", enabled });

      const tallyItem = (tone, label, value, note) =>
        h(
          "span",
          { className: "cc-tally-item", key: tone },
          h("i", { className: `cc-dot is-${tone}` }),
          h("span", null, label),
          h("b", null, String(value)),
          note ? h("span", { className: "cc-muted" }, note) : null,
        );

      return h(
        "section",
        { className: "cc-block" },
        h(
          "div",
          { className: "cc-block-head" },
          h("h2", { className: "cc-h2" }, isGlobal ? "全局管控" : "工作区与项目"),
          h(
            "p",
            { className: "cc-hint" },
            isGlobal
              ? "这里改的档位对所有项目生效；某个项目自己的覆盖优先。"
              : "技能 / MCP / 插件 / 系统提示都按工作目录归属；子项目继承父项目，再叠加自己的档位。",
          ),
        ),

        !isGlobal && h(
          "div",
          { className: "cc-projline" },
          h(
            "select",
            {
              className: "cc-select",
              value: selected.id,
              disabled: busy,
              "aria-label": "项目",
              onChange: (event) => setProjectId(event.target.value),
            },
            projects.map((item) =>
              h("option", { key: item.id, value: item.id },
                `${item.name}${item.auto ? "（工作区）" : ""}${item.missing ? "（已移除）" : ""}${item.matched ? "（当前会话）" : ""}`),
            ),
          ),
          selected.matched ? h("span", { className: "cc-pill is-on" }, "当前会话") : null,
          selected.auto ? h("span", { className: "cc-pill" }, selected.missing ? "工作区已移除" : "自动同步") : null,
          h("span", { className: "cc-muted" }, `工作区 ${projects.filter((item) => item.auto).length} 个已同步`),
          h(
            "button",
            {
              type: "button",
              className: "cc-link is-muted",
              disabled: busy || selected.builtin || selected.auto,
              title: selected.builtin
                ? "「工作区默认」是继承链的根，不能删除"
                : selected.auto
                  ? "工作区项目是自动同步的，不能删除；不想用就把开关关掉"
                  : "删除这个项目（子项目会上移一层）",
              onClick: () => void act({ action: "deleteProject", id: selected.id }),
            },
            "删除项目",
          ),
        ),

        !isGlobal && h(
          "div",
          { className: "cc-projmeta" },
          selected.cwd
            ? h("code", null, selected.cwd)
            : h("span", null, selected.builtin ? "继承链的根：所有工作区默认从这里取档位" : "没绑定目录：只当一层档位用"),
          selected.matched
            ? h("span", null, `当前会话 → 命中「${projects.find((item) => item.id === state.activeProjectId)?.name ?? "?"}」`)
            : h("span", null, "没有活跃会话命中这个项目：改完仍对下一次请求生效"),
          state.awake?.length ? h("span", null, `本会话已自动恢复 ${state.awake.length} 项`) : null,
        ),

        h(
          "div",
          { className: "cc-tally" },
          tallyItem("on", "加载", buckets.on.length, `≈${formatTokens(sumTokens(buckets.on))}`),
          tallyItem("brief", "只留简介", buckets.brief.length, buckets.brief.length ? `少发 ≈${formatTokens(sumTokens(buckets.brief))}` : ""),
          tallyItem("hidden", "完全不显示", buckets.hidden.length, buckets.hidden.length ? `少发 ≈${formatTokens(sumTokens(buckets.hidden))}` : ""),
          h("span", { className: "cc-tally-item" },
            h("span", null, "合计少发"),
            h("b", null, `≈${formatTokens(savedTokens)}`)),
        ),

        h(
          "div",
          { className: "cc-actions" },
          h("span", { className: "cc-actions-label" }, isGlobal ? "全局" : "所有项目"),
          h("button", {
            type: "button",
            className: "cc-btn is-mini",
            disabled: busy,
            title: isGlobal ? "全局所有能力都完整加载" : "所有项目、所有能力都完整加载",
            onClick: () => bulkAll(true),
          }, "全部打开"),
          h("button", {
            type: "button",
            className: "cc-btn is-mini",
            disabled: busy,
            title: isGlobal ? "全局所有能力只留简介" : "所有项目、所有能力只留简介",
            onClick: () => {
              if (!window.confirm((isGlobal ? "把全局的" : "把所有项目的") + "技能、MCP、插件都设成「只留简介」？正文不再发送，需要时模型会自己恢复。")) return;
              void bulkAll(false);
            },
          }, "全部只留简介"),
          h("button", {
            type: "button",
            className: "cc-btn is-mini is-danger",
            disabled: busy,
            title: isGlobal ? "全局所有能力都完全不显示" : "所有项目、所有能力都完全不显示",
            onClick: () => {
              if (!window.confirm((isGlobal ? "把全局的" : "把所有项目的") + "技能、MCP、插件都设成「完全不显示」？模型连简介都看不到，被调用时会先问你。")) return;
              void bulkAll("hidden");
            },
          }, "全部隐藏"),
          h(
            "label",
            { className: "cc-check", style: { marginLeft: "auto" } },
            h("input", {
              type: "checkbox",
              checked: state.brief?.enabled !== false,
              disabled: busy,
              onChange: (event) => void act({ action: "setBrief", enabled: event.target.checked }),
            }),
            h("span", null, "关掉项保留一行简介"),
          ),
        ),

        offCount > 0
          ? h("div", { className: "cc-muted", style: { marginTop: "8px" } },
              `${isGlobal ? "全局" : "本项目"}关掉 ${offCount} 项${state.brief?.enabled !== false ? "，模型仍会看到一行简介" : "，连简介也不留"}；整组明细见下。`)
          : null,
        state.awake?.length
          ? h("div", { className: "cc-muted", style: { marginTop: "6px" } },
              `本会话已自动恢复：${state.awake.join("、")}`)
          : null,
        state.brief?.preview
          ? h("details", { className: "cc-brief" },
              h("summary", null, "看看模型实际收到的简介"),
              h("pre", { className: "cc-brief-text" }, state.brief.preview))
          : null,

        h(SubTabs, {
          items: [
            ...CAP_GROUPS.map((group) => {
              const list = catalog[group.key] ?? [];
              const onTokens = list.reduce(
                (sum, entry) => sum + (modeOfCaps(caps, entry.key) === "on" ? entry.tokens ?? 0 : 0),
                0,
              );
              const offTokens = list.reduce(
                (sum, entry) => sum + (modeOfCaps(caps, entry.key) === "on" ? 0 : entry.tokens ?? 0),
                0,
              );
              return {
                key: group.key,
                label: group.title.replace(" 服务", ""),
                badge: `${list.filter((entry) => modeOfCaps(caps, entry.key) === "on").length}/${list.length}`,
                note: `≈${formatTokens(onTokens)}`,
                minus: offTokens ? `−≈${formatTokens(offTokens)}` : "",
              };
            }),
            { key: "prompt", label: "系统提示", badge: String(scopeSectionCount), note: `≈${formatTokens(scopeSectionTokens)}`, minus: scopeStats("sections").offT ? `−≈${formatTokens(scopeStats("sections").offT)}` : "" },
            { key: "tools", label: "系统工具", badge: `${scopeToolLoaded}/${scopeToolCount}`, note: `≈${formatTokens(scopeToolTokens)}`, minus: scopeStats("tools").offT ? `−≈${formatTokens(scopeStats("tools").offT)}` : "" },
          ],
          value: view,
          onChange: (next) => { setView(next); setCapQuery(""); setCapStatus("all"); },
        }),

        (() => {
          if (view === "prompt" || view === "tools") {
            const st = scopeStats(view === "prompt" ? "sections" : "tools");
            return h("div", { className: "cc-stats" },
              h("span", null, "当前占用 ", h("b", null, "≈" + formatTokens(st.loaded))),
              h("span", null, "全量 ", h("b", null, "≈" + formatTokens(st.full))),
              st.off ? h("span", { className: "is-err" }, "关闭 ", h("b", null, String(st.off)), " · ≈" + formatTokens(st.offT)) : null,
              h("span", null, "合计少发 ", h("b", null, "≈" + formatTokens(st.offT))),
            );
          }
          const group = CAP_GROUPS.find((item) => item.key === view) ?? CAP_GROUPS[0];
          const list = catalog[group.key] ?? [];
          const mOn = list.filter((entry) => modeOfCaps(caps, entry.key) === "on");
          const mBrief = list.filter((entry) => modeOfCaps(caps, entry.key) === "brief");
          const mHidden = list.filter((entry) => modeOfCaps(caps, entry.key) === "hidden");
          const sumT = (arr) => arr.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
          return h("div", { className: "cc-stats" },
            h("span", null, group.title.replace(" 服务", ""), " ", h("b", null, String(list.length)), " 项"),
            h("span", null, "当前 ", h("b", null, "≈" + formatTokens(sumT(mOn)))),
            h("span", { className: "is-warn" }, "简介 ", h("b", null, String(mBrief.length)), mBrief.length ? " · 少发 ≈" + formatTokens(sumT(mBrief)) : ""),
            h("span", { className: "is-err" }, "隐藏 ", h("b", null, String(mHidden.length)), mHidden.length ? " · 少发 ≈" + formatTokens(sumT(mHidden)) : ""),
            h("span", null, "合计少发 ", h("b", null, "≈" + formatTokens(sumT(mBrief) + sumT(mHidden)))),
          );
        })(),

        view === "prompt" || view === "tools"
          ? h(ScopeRules, {
              state,
              busy,
              act,
              scopeId: selected.id,
              kind: view === "prompt" ? "sections" : "tools",
            })
          : (() => {
              const group = CAP_GROUPS.find((item) => item.key === view) ?? CAP_GROUPS[0];
              const all = catalog[group.key] ?? [];
              const q = capQuery.trim().toLowerCase();
              const searched = q
                ? all.filter((entry) => String(entry.name ?? "").toLowerCase().includes(q)
                    || String(entry.summary ?? "").toLowerCase().includes(q)
                    || String(entry.id ?? "").toLowerCase().includes(q))
                : all;
              const entries = searched.filter((entry) => statusMatches(capStatus, modeOfCaps(caps, entry.key) === "on"));
              return h("div", null,
                h("div", { className: "cc-search" },
                  h("input", {
                    className: "cc-input",
                    placeholder: "在本层搜索…",
                    value: capQuery,
                    spellCheck: false,
                    onChange: (event) => setCapQuery(event.target.value),
                  }),
                  h(StatusFilter, { value: capStatus, onChange: setCapStatus, busy }),
                  h("span", { className: "cc-muted" }, q || capStatus !== "all" ? entries.length + " / " + all.length + " 项" : all.length + " 项"),
                ),
                h(CapGroup, {
                key: group.key,
                bare: true,
                hint: group.hint,
                entries,
                caps,
                busy,
                emptyText: group.key === "skills" ? SKILL_EMPTY_TEXT : undefined,
                scopeLabel: isGlobal ? "全局" : "本项目",
                onSet: set,
                onReset: reset,
                onAll: (enabled) => void act({ action: "setCaps", projectId: selected.id, group: group.key, enabled }),
                }),
              );
            })(),

        !isGlobal && h(
          "details",
          { className: "cc-brief" },
          h("summary", null, "项目设置：名称 · 工作目录 · 继承 · 新建子项目"),
          h(
            "div",
            { className: "cc-list", style: { paddingTop: "10px" } },
            h(
              "div",
              { className: "cc-row", style: { gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) minmax(0,1fr)" } },
              h("label", { className: "cc-field" },
                h("span", { className: "cc-field-label" }, "名称"),
                h("input", {
                  key: `${selected.id}-name`,
                  className: "cc-input",
                  defaultValue: selected.name,
                  maxLength: 60,
                  disabled: busy,
                  onBlur: (event) => {
                    const value = event.target.value.trim();
                    if (value && value !== selected.name) saveField({ name: value });
                  },
                }),
              ),
              h("label", { className: "cc-field" },
                h("span", { className: "cc-field-label" }, "工作目录"),
                h("input", {
                  key: `${selected.id}-cwd`,
                  className: "cc-input",
                  defaultValue: selected.cwd,
                  placeholder: "留空 = 只做继承根，不匹配任何会话",
                  spellCheck: false,
                  disabled: busy,
                  onBlur: (event) => {
                    const value = event.target.value.trim();
                    if (value !== selected.cwd) saveField({ cwd: value });
                  },
                }),
              ),
              h("label", { className: "cc-field" },
                h("span", { className: "cc-field-label" }, "继承自"),
                h(
                  "select",
                  {
                    className: "cc-select",
                    value: selected.parentId ?? "",
                    disabled: busy || selected.builtin,
                    onChange: (event) => saveField({ parentId: event.target.value || null }),
                  },
                  selected.builtin
                    ? h("option", { value: "" }, "（根）")
                    : [h("option", { key: "__none__", value: "" }, "（只用自己的开关）")].concat(
                        parentOptions.map((item) => h("option", { key: item.id, value: item.id }, item.name)),
                      ),
                ),
              ),
            ),
            h(
              "div",
              { className: "cc-row-gap", style: { paddingTop: "10px" } },
              h("input", {
                className: "cc-input",
                placeholder: "子项目名（如 前端 / 后台）",
                value: newName,
                maxLength: 60,
                disabled: busy,
                onChange: (event) => setNewName(event.target.value),
              }),
              h("input", {
                className: "cc-input",
                placeholder: "工作目录（可留空）",
                value: newCwd,
                spellCheck: false,
                disabled: busy,
                onChange: (event) => setNewCwd(event.target.value),
              }),
              h(
                "button",
                {
                  type: "button",
                  className: "cc-btn",
                  disabled: busy || !newName.trim(),
                  onClick: () =>
                    void act({
                      action: "createProject",
                      name: newName.trim(),
                      cwd: newCwd.trim(),
                      parentId: selected.id,
                    }).then((result) => {
                      if (result) {
                        setNewName("");
                        setNewCwd("");
                      }
                    }),
                },
                "新建并继承当前项目",
              ),
            ),
          ),
        ),
      );
    }

    function AiBlock({ scope, sessionId, state, act, busy, title }) {
      const [suggestion, setSuggestion] = useState(null);
      const [picked, setPicked] = useState({});
      const [undoToken, setUndoToken] = useState("");
      const [localError, setLocalError] = useState("");
      const [stale, setStale] = useState(false);
      const ai = state?.ai ?? {};
      const label = title || (scope === "global" ? "AI 最低可用建议" : scope === "project" ? "AI 优化本项目" : scope === "session" ? "AI 优化本会话" : "AI 分析本页");

      if (!ai.enabled) {
        return h("div", { className: "cc-ai" },
          h("button", {
            type: "button",
            className: "cc-btn is-mini",
            disabled: busy,
            onClick: async () => {
              const result = await act({ action: "setAi", enabled: true, privacyAccepted: true });
              if (!result) setLocalError("启用失败");
            },
          }, "启用 AI 建议"),
          h("span", { className: "cc-ai-note" }, "默认关闭；启用后会把条目名称、类型与 token 数发送给当前会话的模型。"),
        );
      }
      if (!ai.available) {
        return h("div", { className: "cc-ai" }, h("span", { className: "cc-ai-note" }, ai.reason || "当前没有可用模型路由。"));
      }

      useEffect(() => {
        let alive = true;
        if (suggestion) return undefined;
        act({ action: "aiLast", scope, sessionId }).then((result) => {
          const previous = result?.suggestion ?? null;
          if (!alive || !previous) return;
          setSuggestion(previous);
          setStale(result.stale === true);
          setPicked(Object.fromEntries((previous.items ?? []).filter((item) => item.action !== "keep" && !item.blocked).map((item) => [item.id, true])));
        });
        return () => { alive = false; };
      }, [scope, sessionId, ai.enabled]);

      const run = async () => {
        setLocalError("");
        setStale(false);
        const result = await act({ action: "aiSuggest", scope, sessionId });
        const next = result?.suggestion ?? null;
        setSuggestion(next);
        setUndoToken("");
        setPicked(Object.fromEntries((next?.items ?? []).filter((item) => item.action !== "keep" && !item.blocked).map((item) => [item.id, true])));
      };
      const apply = async () => {
        if (!suggestion) return;
        const ids = suggestion.items.filter((item) => picked[item.id] && item.action !== "keep").map((item) => item.id);
        if (!ids.length) { setLocalError("没有选中任何建议。"); return; }
        const result = await act({ action: "aiApply", suggestionId: suggestion.id, itemIds: ids, confirm: true });
        if (result?.undoToken) {
          setUndoToken(result.undoToken);
          setSuggestion(null);
        }
      };
      const undo = async () => {
        if (!undoToken) return;
        const result = await act({ action: "aiUndo", undoToken });
        if (result) setUndoToken("");
      };

      return h("div", { className: "cc-ai" },
        h("div", { className: "cc-ai-head" },
          h("button", { type: "button", className: "cc-btn is-mini", disabled: busy, onClick: () => void run() }, busy ? "分析中…" : label),
          h("span", { className: "cc-ai-note" }, `只写${scope === "session" ? "本会话" : scope === "parts" ? "当前模式" : scope === "project" ? "当前项目" : "全局"}层 · 点击才调用模型`),
          undoToken ? h("button", { type: "button", className: "cc-btn is-ghost is-mini", disabled: busy, onClick: () => void undo() }, "撤销") : null,
          h("button", {
            type: "button",
            className: "cc-btn is-ghost is-mini",
            disabled: busy,
            title: "关闭 AI 建议并清空隐私确认",
            onClick: () => void act({ action: "setAi", enabled: false, privacyAccepted: false }),
          }, "关闭 AI"),
        ),
        localError ? h("div", { className: "cc-alert" }, localError) : null,
        suggestion
          ? h("div", { className: "cc-ai-card" },
              h("div", { className: "cc-ai-summary" }, suggestion.summary, h("span", { className: "cc-ai-meta" }, `${suggestion.provider}/${suggestion.model}${suggestion.cached ? " · 缓存" : ""}`)),
              stale ? h("div", { className: "cc-ai-note" }, "配置已变化，应用前请重新分析。") : null,
              suggestion.warnings?.length ? h("div", { className: "cc-ai-warn" }, `部分条目未覆盖：${suggestion.warnings.slice(0, 3).join("；")}`) : null,
              suggestion.items.filter((item) => item.action !== "keep").slice(0, 12).map((item) =>
                h("label", { key: item.id, className: "cc-ai-row" },
                  h("input", {
                    type: "checkbox",
                    checked: Boolean(picked[item.id]),
                    disabled: Boolean(item.blocked),
                    onChange: (event) => setPicked((prev) => ({ ...prev, [item.id]: event.target.checked })),
                  }),
                  h("span", { className: "cc-ai-name" }, item.name),
                  h("span", { className: `cc-ai-action is-${item.action}` }, item.action === "hide" ? "隐藏" : item.action === "brief" ? "简介" : item.action === "rewrite" ? "改写" : item.action === "on" ? "开启" : item.action === "off" ? "关闭" : item.action),
                  h("span", { className: "cc-ai-why" }, item.blocked || item.reason || ""),
                  h("span", { className: "cc-ai-save" }, item.savedTokens ? `−${formatTokens(item.savedTokens)}` : ""),
                ),
              ),
              h("div", { className: "cc-ai-foot" },
                h("button", { type: "button", className: "cc-btn is-mini is-primary", disabled: busy || stale, onClick: () => void apply() }, "应用选中"),
                h("button", { type: "button", className: "cc-btn is-ghost is-mini", disabled: busy, onClick: () => setSuggestion(null) }, "取消"),
                h("span", { className: "cc-ai-note" }, suggestion.partial ? "部分建议已过滤，应用前请核对。" : "应用前可先取消勾选。"),
              ),
            )
          : null,
      );
    }

    function Panel() {
      const [state, setState] = useState(null);
      const [session, setSession] = useState(null);
      const [sessionId, setSessionId] = useState("");
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      const [editing, setEditing] = useState(null);
      const [newName, setNewName] = useState("");
      const [renaming, setRenaming] = useState(false);
      const [showTools, setShowTools] = useState(false);
      const [toolQuery, setToolQuery] = useState("");
      const [toolStatus, setToolStatus] = useState("all");
      const [showEmpty, setShowEmpty] = useState(false);
      const [partsTab, setPartsTab] = useState("sections");
      const [partsGroup, setPartsGroup] = useState("system");
      const [leafQuery, setLeafQuery] = useState("");
      const [leafStatus, setLeafStatus] = useState("all");
      const [tab, setTab] = useState("parts");
      const [inlineAi, setInlineAi] = useState(null);

      const load = useCallback(async () => {
        try {
          const data = await request(null, sessionId ? { sessionId } : undefined);
          setState(data);
          setError(data.lastError || "");
        } catch (err) {
          setError(messageOf(err));
        }
      }, [sessionId]);

      useEffect(() => {
        void load();
      }, [load]);

      useEffect(() => {
        let alive = true;
        if (!sessionId) {
          setSession(null);
          return undefined;
        }
        request(null, { action: "session", sessionId })
          .then((data) => {
            if (alive) setSession(data.session ?? null);
          })
          .catch((err) => {
            if (alive) setSession({ ok: false, error: messageOf(err) });
          });
        return () => {
          alive = false;
        };
      }, [sessionId, state?.activeModeId]);

      const act = useCallback(
        async (payload) => {
          setBusy(true);
          try {
            const result = await request(payload);
            if (result.state) setState(result.state);
            else await load();
            setError("");
            return result;
          } catch (err) {
            setError(messageOf(err));
            return null;
          } finally {
            setBusy(false);
          }
        },
        [load],
      );

      const askInline = async (itemId, name) => {
        setInlineAi({ itemId, name, loading: true, suggestion: null, error: "" });
        const result = await act({ action: "aiSuggest", scope: "item", itemId });
        const suggestion = result?.suggestion ?? null;
        setInlineAi((current) => current && current.itemId === itemId
          ? { ...current, loading: false, suggestion, error: suggestion ? "" : (result?.message || "没有拿到建议") }
          : current);
      };
      const applyInline = async () => {
        const current = inlineAi;
        const suggestion = current?.suggestion;
        if (!suggestion) return;
        const item = suggestion.items.find((entry) => entry.id === current.itemId);
        if (!item) return;
        const result = await act({ action: "aiApply", suggestionId: suggestion.id, itemIds: [item.id], confirm: true });
        if (result?.ok) {
          setInlineAi({ ...current, suggestion: null, applied: true, undoToken: result.undoToken || "" });
        }
      };
      const undoInline = async () => {
        if (!inlineAi?.undoToken) return;
        const result = await act({ action: "aiUndo", undoToken: inlineAi.undoToken });
        if (result?.ok) setInlineAi(null);
      };
      const inlineView = () => {
        if (!inlineAi) return null;
        const suggestion = inlineAi.suggestion;
        const item = suggestion?.items?.find((entry) => entry.id === inlineAi.itemId);
        return h("div", { className: "cc-ai-inline" },
          h("div", { className: "cc-ai-inline-head" },
            h("b", null, inlineAi.name || inlineAi.itemId),
            h("span", { className: "cc-ai-note" }, "单条建议 · 不影响其他项"),
            h("button", { type: "button", className: "cc-link", onClick: () => setInlineAi(null) }, "关闭"),
          ),
          inlineAi.loading ? h("div", { className: "cc-ai-note" }, "分析这一项…")
            : inlineAi.applied ? h("div", { className: "cc-ai-inline-row" },
                h("span", { className: "cc-alert is-ok" }, "已应用"),
                inlineAi.undoToken ? h("button", { type: "button", className: "cc-btn is-ghost is-mini", onClick: () => void undoInline() }, "撤销") : null,
              )
            : suggestion && item ? h("div", { className: "cc-ai-inline-row" },
                h("span", { className: `cc-ai-action is-${item.action}` }, item.action === "hide" ? "隐藏" : item.action === "brief" ? "简介" : item.action === "rewrite" ? "改写" : "保留"),
                h("span", { className: "cc-ai-why" }, item.reason || ""),
                item.savedTokens ? h("span", { className: "cc-ai-save" }, `−${formatTokens(item.savedTokens)}`) : null,
                h("button", { type: "button", className: "cc-btn is-mini", disabled: busy, onClick: () => void applyInline() }, "应用这一项"),
              )
            : h("div", { className: "cc-ai-warn" }, inlineAi.error || suggestion?.warnings?.[0] || "这一项没有可执行建议。"),
        );
      };

      const mode = useMemo(() => {
        if (!state) return null;
        return state.modes.find((item) => item.id === state.activeModeId) ?? state.modes[0];
      }, [state]);

      const rules = mode?.rules ?? { sections: {}, contexts: {}, tools: {} };
      const aiEnabled = state?.ai?.enabled === true;
      const ruleFor = (kind, name) => rules[kind]?.[name] ?? null;

      const toggle = (kind, name, next) =>
        act({ action: "setRule", kind, name, patch: { enabled: next ? true : false } });
      const resetRule = (kind, name) => act({ action: "setRule", kind, name, patch: { text: null } });

      if (!state) {
        return h(
          "div",
          { className: "cc-page" },
          h("div", { className: "cc-empty" }, error ? `读取失败：${error}` : "正在读取上下文…"),
        );
      }

      const prompt = state.prompt ?? { sections: [], contexts: [], tools: [] };

      // 0 token 的空段（很多插件注册了段但当前没文本）默认收起，不然一屏全是 0。
      // 已经被改过的段无论如何都留着，否则用户关掉之后再想打开就找不到入口了。
      const keep = (kind, item) =>
        showEmpty || item.tokens > 0 || Boolean(ruleFor(kind, item.name)) || item.name === editing?.name;
      const visibleSections = prompt.sections.filter((item) => keep("sections", item));
      const visibleContexts = prompt.contexts.filter((item) => keep("contexts", item));
      const hiddenCount = prompt.sections.length - visibleSections.length + prompt.contexts.length - visibleContexts.length;

      const sectionsByGroup = new Map();
      for (const section of visibleSections) {
        const key = section.group || "system";
        const list = sectionsByGroup.get(key) ?? [];
        list.push(section);
        sectionsByGroup.set(key, list);
      }

      // 能力开关（MCP / 插件整组）也会摘掉工具：面板必须按同一套规则算「当前加载」和少发的量，
      // 否则关掉 github 之后这里仍显示 158 个工具，看着像没生效。
      const panelCaps = (() => {
        const row = (state.projects ?? []).find((item) => item.id === state.activeProjectId);
        return row?.resolvedCaps ?? state.caps ?? {};
      })();
      const capModeOfTool = (tool) => (tool.capKey ? modeOfCaps(panelCaps, tool.capKey) : "on");
      const toolIsOff = (tool) =>
        ruleFor("tools", tool.name)?.enabled === false || capModeOfTool(tool) !== "on";
      const enabledTools = prompt.tools.filter((tool) => !toolIsOff(tool));
      // 停用 = 模式里关掉的段落/工具 + 项目能力里降到「简介/隐藏」的项。
      const capOffCount = (() => {
        const catalog = state.capabilities ?? { skills: [], mcp: [], plugins: [] };
        const caps = state.caps ?? {};
        const all = [...(catalog.skills ?? []), ...(catalog.mcp ?? []), ...(catalog.plugins ?? [])];
        return all.filter((entry) => caps[entry.key] === false || caps[entry.key] === "hidden").length;
      })();
      const disabledCount =
        capOffCount +
        prompt.sections.filter((item) => ruleFor("sections", item.name)?.enabled === false).length +
        prompt.contexts.filter((item) => ruleFor("contexts", item.name)?.enabled === false).length +
        prompt.tools.filter((item) => toolIsOff(item)).length;

      const loadedSections = prompt.sections.reduce(
        (sum, item) => sum + (ruleFor("sections", item.name)?.enabled === false ? 0 : item.tokens), 0);
      const loadedContexts = prompt.contexts.reduce(
        (sum, item) => sum + (ruleFor("contexts", item.name)?.enabled === false ? 0 : item.tokens), 0);
      const loadedTools = enabledTools.reduce((sum, item) => sum + item.tokens, 0);
      const loadedTotal = loadedSections + loadedContexts + loadedTools;

      const searchedTools = toolQuery
        ? prompt.tools.filter((tool) => tool.name.toLowerCase().includes(toolQuery.toLowerCase()))
        : prompt.tools;
      const filteredTools = searchedTools.filter((tool) => statusMatches(toolStatus, !toolIsOff(tool)));

      // 一键精简：把最占地方的三份工具文档降到「简介」档（正文不发，只留一行说明）。
      const heavyKeys = ["mcp:github", "plugin:agent-teams", "plugin:mcp-connector"];
      const trimHeavyTools = async () => {
        for (const key of heavyKeys) {
          if (modeOfCaps(panelCaps, key) === "on") {
            await act({ action: "setCap", projectId: state.activeProjectId ?? "workspace", key, enabled: false });
          }
        }
      };

      const safeQuery = state.sessions ?? [];
      const activeSession = sessionId || safeQuery[0]?.id || "";
      const contextWindow = session?.pressure?.contextWindow ?? null;

      const parts = [
        { key: "sections", label: "系统内容", tokens: loadedSections },
        { key: "contexts", label: "运行时注入", tokens: loadedContexts },
        { key: "tools", label: "工具定义", tokens: loadedTools },
      ];
      const meterTotal = Math.max(1, loadedTotal);
      const promptMeta =
        prompt.source === "snapshot"
          ? `最近实测 ${timeOf(prompt.at)}`
          : prompt.source === "live"
            ? "现场探测"
            : "还没装配过";
      const modeStats = mode?.stats ?? { disabled: 0, edited: 0 };
      const capTotal = ["skills", "mcp", "plugins"].reduce(
        (sum, key) => sum + (state?.capabilities?.[key]?.length ?? 0),
        0,
      );
      const catalogAll = [...(state?.capabilities?.skills ?? []), ...(state?.capabilities?.mcp ?? []), ...(state?.capabilities?.plugins ?? [])];
      const potentialOf = (caps) =>
        catalogAll.reduce(
          (sum, entry) => sum + (modeOfCaps(caps ?? {}, entry.key) === "on" ? entry.tokens ?? 0 : 0),
          0,
        );
      const projectRow = (state?.projects ?? []).find((item) => item.id === state?.activeProjectId) ?? null;
      const capsNote = potentialOf(projectRow?.resolvedCaps ?? {});
      const globalNote = potentialOf(state?.global?.caps ?? {});
      const tabs = [
        { key: "parts", label: "构成", badge: `${visibleSections.length + visibleContexts.length} 段`, note: `≈${formatTokens(loadedTotal)}` },
        { key: "caps", label: "项目", badge: capTotal > 0 ? `${capTotal} 项` : "", note: `≈${formatTokens(capsNote)}` },
        { key: "global", label: "全局", badge: "", note: `≈${formatTokens(globalNote)}` },
      ];
      const tabButton = (item) =>
        h(
          "button",
          {
            key: item.key,
            type: "button",
            role: "tab",
            "aria-selected": tab === item.key ? "true" : "false",
            className: "cc-tab",
            onClick: () => setTab(item.key),
          },
          h("span", null, item.label),
          item.badge ? h("span", { className: "cc-badge" }, item.badge) : null,
          item.note ? h("span", { className: "cc-tab-note" }, item.note) : null,
        );

      const groupTabs = [...sectionsByGroup.entries()].map(([key, list]) => {
        const offs = list.reduce(
          (sum, item) => sum + (ruleFor("sections", item.name)?.enabled === false ? item.tokens ?? 0 : 0),
          0,
        );
        return {
          key,
          label: GROUP_LABELS[key] || "其他",
          badge: `${list.length} 段`,
          note: `≈${formatTokens(list.reduce((sum, item) => sum + (item.tokens ?? 0), 0))}`,
          minus: offs ? `−≈${formatTokens(offs)}` : "",
          list,
        };
      });
      const activeGroup = groupTabs.find((item) => item.key === partsGroup) ?? groupTabs[0] ?? null;

      const sumStats = (kind, items) => {
        let loaded = 0, full = 0, brief = 0, briefT = 0, hidden = 0, hiddenT = 0;
        for (const item of items) {
          const t = item.tokens ?? 0;
          full += t;
          if (ruleFor(kind, item.name)?.enabled !== false) { loaded += t; continue; }
          if (state.brief?.enabled !== false) { brief += 1; briefT += t; } else { hidden += 1; hiddenT += t; }
        }
        return { loaded, full, brief, briefT, hidden, hiddenT, saved: briefT + hiddenT };
      };
      const sectionStats = sumStats("sections", prompt.sections);
      const contextStats = sumStats("contexts", prompt.contexts);
      const toolStats = (() => {
        const base = sumStats("tools", prompt.tools);
        let loaded = 0, full = 0, brief = 0, briefT = 0, hidden = 0, hiddenT = 0;
        for (const tool of prompt.tools) {
          const t = tool.tokens ?? 0;
          full += t;
          const mode = capModeOfTool(tool);
          if (ruleFor("tools", tool.name)?.enabled === false) {
            if (state.brief?.enabled !== false) { brief += 1; briefT += t; } else { hidden += 1; hiddenT += t; }
            continue;
          }
          if (mode === "hidden") { hidden += 1; hiddenT += t; continue; }
          if (mode === "brief") { brief += 1; briefT += t; continue; }
          loaded += t;
        }
        return { loaded, full, brief, briefT, hidden, hiddenT, saved: briefT + hiddenT, base };
      })();
      const groupStats = (list) => sumStats("sections", list ?? []);
      const statBar = (stats, count) =>
        h("div", { className: "cc-stats" },
          typeof count === "number" ? h("span", null, count, " 项") : null,
          h("span", null, "当前占用 ", h("b", null, "≈" + formatTokens(stats.loaded))),
          h("span", null, "全量 ", h("b", null, "≈" + formatTokens(stats.full))),
          stats.brief ? h("span", { className: "is-warn" }, "简介 ", h("b", null, String(stats.brief)), " · ≈" + formatTokens(stats.briefT)) : null,
          stats.hidden ? h("span", { className: "is-err" }, "隐藏 ", h("b", null, String(stats.hidden)), " · ≈" + formatTokens(stats.hiddenT)) : null,
          h("span", null, "合计少发 ", h("b", null, "≈" + formatTokens(stats.saved))),
        );
      const matchLeaf = (item, kind) => {
        const q = leafQuery.trim().toLowerCase();
        const matched = !q || String(item.name ?? "").toLowerCase().includes(q)
          || String(item.preview ?? item.text ?? item.summary ?? "").toLowerCase().includes(q);
        return matched && statusMatches(leafStatus, ruleFor(kind, item.name)?.enabled !== false);
      };
      const shownSections = (activeGroup?.list ?? []).filter((item) => matchLeaf(item, "sections"));
      const shownContexts = visibleContexts.filter((item) => matchLeaf(item, "contexts"));
      const leafSearch = (all, shown) =>
        h("div", { className: "cc-search" },
          h("input", {
            className: "cc-input",
            placeholder: "在本层搜索…",
            value: leafQuery,
            spellCheck: false,
            onChange: (event) => setLeafQuery(event.target.value),
          }),
          h(StatusFilter, { value: leafStatus, onChange: setLeafStatus, busy }),
          h("span", { className: "cc-muted" }, shown === all ? all + " 项" : shown + " / " + all + " 项"),
        );

      const partsView = h(
        "div",
        null,
        h(
          "div",
          { className: "cc-toolbar" },
          h(
            "label",
            { className: "cc-check" },
            h("input", {
              type: "checkbox",
              checked: showEmpty,
              onChange: (event) => setShowEmpty(Boolean(event.target.checked)),
            }),
            h("span", null, "显示 0 token 的空段"),
          ),
          h("span", { className: "cc-muted" }, hiddenCount > 0 ? `已收起 ${hiddenCount} 段` : "没有空段"),
          h("span", { className: "cc-muted" }, prompt.toolsFrom === "schemas" ? "工具清单来自实时工具表" : ""),
          h("span", { className: "cc-count" }, `合计 ≈${formatTokens(loadedTotal)}`),
        ),
        h(SubTabs, {
          items: [
            { key: "sections", label: "系统提示", badge: `${visibleSections.length} 段`, note: `≈${formatTokens(loadedSections)}`, minus: sectionStats.saved ? `−≈${formatTokens(sectionStats.saved)}` : "" },
            { key: "contexts", label: "运行时注入", badge: `${visibleContexts.length} 段`, note: `≈${formatTokens(loadedContexts)}`, minus: contextStats.saved ? `−≈${formatTokens(contextStats.saved)}` : "" },
            { key: "tools", label: "工具定义", badge: `${enabledTools.length}/${prompt.tools.length} 个`, note: `≈${formatTokens(loadedTools)}`, minus: toolStats.saved ? `−≈${formatTokens(toolStats.saved)}` : "" },
          ],
          value: partsTab,
          onChange: (next) => { setPartsTab(next); setLeafQuery(""); setLeafStatus("all"); },
        }),
        partsTab === "sections"
          ? h(
              "div",
              null,
              groupTabs.length > 1
                ? h(SubTabs, {
                    items: groupTabs,
                    value: activeGroup?.key ?? "",
                    level: "secondary",
                    onChange: (next) => { setPartsGroup(next); setLeafQuery(""); setLeafStatus("all"); },
                  })
                : null,
              statBar(groupStats(activeGroup?.list ?? []), activeGroup?.list?.length ?? 0),
              leafSearch(activeGroup?.list?.length ?? 0, shownSections.length),
              activeGroup
                ? h(
                    "div",
                    { className: "cc-list" },
                    shownSections.map((item) =>
                      editing && editing.kind === "sections" && editing.name === item.name
                        ? h(Editor, {
                            key: `${item.name}-edit`,
                            title: `编辑 · ${item.name}`,
                            value: ruleFor("sections", item.name)?.text ?? item.text,
                            busy,
                            onCancel: () => setEditing(null),
                            onSave: async (text) => {
                              await act({ action: "setRule", kind: "sections", name: item.name, patch: { text } });
                              setEditing(null);
                            },
                          })
                        : h(ModuleRow, {
                            key: item.name,
                            item,
                            rule: ruleFor("sections", item.name),
                            busy,
                            onToggle: (next) => void toggle("sections", item.name, next),
                            onEdit: () => setEditing({ kind: "sections", name: item.name }),
                            onReset: () => void resetRule("sections", item.name),
                          }),
                    ),
                  )
                : h("div", { className: "cc-empty is-small" }, "这一层没有可发的系统提示段。"),
            )
          : null,
        partsTab === "contexts"
          ? visibleContexts.length > 0
            ? h(
                "div",
                null,
                statBar(contextStats, visibleContexts.length),
                leafSearch(visibleContexts.length, shownContexts.length),
                h(
                "div",
                { className: "cc-list" },
                shownContexts.map((item) =>
                  editing && editing.kind === "contexts" && editing.name === item.name
                    ? h(Editor, {
                        key: `${item.name}-edit`,
                        title: `编辑 · ${item.name}`,
                        value: ruleFor("contexts", item.name)?.text ?? item.text,
                        busy,
                        onCancel: () => setEditing(null),
                        onSave: async (text) => {
                          await act({ action: "setRule", kind: "contexts", name: item.name, patch: { text } });
                          setEditing(null);
                        },
                      })
                    : h(ModuleRow, {
                        key: item.name,
                        item,
                        rule: ruleFor("contexts", item.name),
                        busy,
                        onToggle: (next) => void toggle("contexts", item.name, next),
                        onEdit: () => setEditing({ kind: "contexts", name: item.name }),
                        onReset: () => void resetRule("contexts", item.name),
                      }),
                ),
                ),
              )
            : h("div", { className: "cc-empty is-small" }, "没有运行时注入。")
          : null,
        partsTab === "tools"
          ? h(
              "div",
              { className: "cc-tools" },
              h(
                "div",
                { className: "cc-toolbar" },
                h("input", {
                  className: "cc-input cc-tools-search",
                  placeholder: "按名字过滤…",
                  value: toolQuery,
                  onChange: (event) => setToolQuery(event.target.value),
                }),
                h(StatusFilter, { value: toolStatus, onChange: setToolStatus, busy }),
                h("span", { className: "cc-muted" },
                  `${enabledTools.length}/${prompt.tools.length} 已加载 · 少发 ≈${formatTokens(prompt.tools.filter(toolIsOff).reduce((sum, tool) => sum + tool.tokens, 0))}`),
                h(
                  "button",
                  {
                    type: "button",
                    className: "cc-btn is-mini",
                    disabled: busy,
                    title: "把 github / agent-teams / mcp-connector 三份工具文档降到「简介」档（每次请求约省 28k token）",
                    onClick: () => void trimHeavyTools(),
                  },
                  "一键精简",
                ),
              ),
              statBar(toolStats, prompt.tools.length),
              h(
                "div",
                { className: "cc-list" },
                filteredTools.length === 0
                  ? h("div", { className: "cc-empty is-small" }, toolQuery || toolStatus !== "all" ? "没有匹配的工具。" : "还没有可读的工具。")
                  : null,
                filteredTools.map((tool) =>
                  h(
                    "div",
                    {
                      key: tool.name,
                      className: `cc-row cc-row-tool${toolIsOff(tool) ? " is-off" : ""}`,
                      title: tool.capKey ? `所属能力：${tool.capKey}` : undefined,
                    },
                    h(Switch, {
                      checked: !toolIsOff(tool),
                      disabled: busy,
                      onChange: (next) => void toggle("tools", tool.name, next),
                    }),
                    h(
                      "div",
                      { className: "cc-row-main" },
                      h("div", { className: "cc-row-title" },
                        h("code", { className: "cc-name" }, tool.name),
                        tool.capKey && capModeOfTool(tool) !== "on"
                          ? h("span", { className: `cc-tag is-${capModeOfTool(tool)}` }, capModeOfTool(tool) === "hidden" ? "隐藏" : "简介")
                          : null),
                      h("div", { className: "cc-row-preview" }, tool.description || "（无描述）"),
                    ),
                    h(Token, { tokens: tool.tokens, muted: ruleFor("tools", tool.name)?.enabled === false }),
                  ),
                ),
              ),
              enabledTools.length === 0
                ? h("div", { className: "cc-alert is-warn" },
                    "所有工具都被停用了：模型将无法调用任何工具（包括执行命令和读文件）。需要时请先把开关打回去。")
                : null,
            )
          : null,
      );

      return h(
        "div",
        { className: "cc-page" },
        h(
          "header",
          { className: "cc-top" },
          h(
            "div",
            { className: "cc-top-main" },
            h("h1", { className: "cc-title" }, "上下文管控"),
            h(
              "div",
              { className: "cc-top-total" },
              h("b", null, `≈${formatTokens(loadedTotal)}`),
              h("span", null, `本次请求 · ${promptMeta}`),
            ),
          ),
          h(
            "div",
            { className: "cc-meter-line" },
            h(
              "div",
              { className: "cc-meter", role: "img", "aria-label": `本次请求约 ${formatTokens(loadedTotal)} tokens` },
              parts.map((part) =>
                h("span", {
                  key: part.key,
                  className: `is-${part.key}`,
                  style: { width: `${Math.max(0, Math.min(100, (part.tokens / meterTotal) * 100))}%` },
                  title: `${part.label} ≈${formatTokens(part.tokens)} tokens`,
                }),
              ),
            ),
            h(
              "div",
              { className: "cc-key" },
              parts.map((part) =>
                h(
                  "span",
                  { key: part.key, className: "cc-key-item" },
                  h("i", { className: `cc-dot is-${part.key}` }),
                  `${part.label} ≈${formatTokens(part.tokens)}`,
                ),
              ),
            ),
          ),
        ),

        h("nav", { className: "cc-tabs", role: "tablist" }, tabs.map(tabButton)),

        h(AiBlock, {
          scope: tab === "caps" ? "project" : tab === "global" ? "global" : "parts",
          sessionId,
          state,
          act,
          busy,
          title: tab === "caps" ? "AI 优化本项目" : tab === "global" ? "AI 最低可用建议" : "AI 分析本页",
        }),

        h(
          "div",
          { className: "cc-view" },
          error ? h("div", { className: "cc-alert" }, error) : null,
          tab === "parts" ? partsView : null,
          tab === "caps" ? h(ProjectCaps, { state, busy, act }) : null,
          tab === "global" ? h(ProjectCaps, { state, busy, act, scopeId: "global" }) : null,
          h(
            "div",
            { className: "cc-foot" },
            h("span", { className: "cc-muted" }, `v${state.version} · 数据：${state.dataDir}`),
            state.toolRestricted ? h("span", { className: "cc-tag" }, "工具限制生效中") : null,
            h("span", { className: "cc-muted" }, "改完从下一次请求生效。"),
          ),
        ),
      );

    }

    /* ------------------------------------------------------- 会话内：小胶囊 + 弹层 */

    function ComposerChip({ sessionId, inputActions }) {
      const [session, setSession] = useState(null);
      const active = useOverlay();
      const open = active.open === true && active.sessionId === sessionId;

      const load = useCallback(async () => {
        try {
          const result = await request(null, { action: "session", sessionId });
          setSession(result.session ?? null);
        } catch {
          /* 静默：胶囊不是关键路径 */
        }
      }, [sessionId]);

      useEffect(() => {
        void load();
        // 压缩是后台发生的，胶囊不轮询就会一直停在打开时的数字。
        const timer = setInterval(() => void load(), 12000);
        const wake = () => void load();
        window.addEventListener("focus", wake);
        document.addEventListener("visibilitychange", wake);
        return () => {
          clearInterval(timer);
          window.removeEventListener("focus", wake);
          document.removeEventListener("visibilitychange", wake);
        };
      }, [load]);

      // 弹层关掉时也刷新一次：用户可能刚在面板里压过。
      useEffect(() => {
        if (!open) void load();
      }, [open, load]);

      // 只报「会话已累积」的计量值——和 DSH 自带的统计是同一个口径。
      const total = session?.ok
        ? (session.pressure?.pressureTokens ?? session.windowTokens ?? session.total)
        : null;

      return h(
        "button",
        {
          type: "button",
          className: `cc-chip${open ? " is-open" : ""}`,
          title: "本会话上下文：每块占用、技能/MCP/插件的开关，都可以在这里改",
          onClick: (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            overlay.set({ open: true, sessionId, input: inputActions ?? null, rect });
          },
          "aria-haspopup": "dialog",
          "aria-expanded": open ? "true" : "false",
          "aria-label": total == null ? "打开上下文面板" : `本会话上下文 ${formatTokens(total)} tokens，打开面板`,
        },
        h("span", { className: "cc-chip-icon", "aria-hidden": "true" }, h(Icon, { size: 14 })),
        total == null ? "上下文" : `上下文 ${formatTokens(total)}`,
        h("span", { className: "cc-chip-caret", "aria-hidden": "true" }, "▾"),
      );
    }

    function collectModules(state, session, mode, removed) {
      const items = [];
      const rules = mode?.rules ?? { sections: {}, contexts: {}, tools: {} };
      const hiddenSections = new Set(removed?.sections ?? []);
      const hiddenContexts = new Set(removed?.contexts ?? []);
      const hiddenTools = new Set(removed?.tools ?? []);

      if (state?.prompt) {
        const bucket = new Map();
        const add = (key, label, tokens) => {
          const current = bucket.get(key) ?? { key, label, tokens: 0, count: 0 };
          current.tokens += Number(tokens) || 0;
          current.count += 1;
          bucket.set(key, current);
        };
        for (const section of state.prompt.sections) {
          if (rules.sections?.[section.name]?.enabled === false) continue;
          if (hiddenSections.has(section.name)) continue;
          add(`prompt:${section.group || "system"}`, GROUP_LABELS[section.group || "system"] || "系统内容", section.tokens);
        }
        for (const context of state.prompt.contexts) {
          if (rules.contexts?.[context.name]?.enabled === false) continue;
          if (hiddenContexts.has(context.name)) continue;
          add("prompt:contexts", "运行时注入", context.tokens);
        }
        for (const tool of state.prompt.tools) {
          if (rules.tools?.[tool.name]?.enabled === false) continue;
          if (hiddenTools.has(tool.name)) continue;
          add("prompt:tools", "工具定义", tool.tokens);
        }
        items.push(...[...bucket.values()].map((item) => ({ ...item, scope: "prompt" })));
      }

      for (const group of session?.groups ?? []) {
        items.push({
          key: `session:${group.key}`,
          label: group.label,
          tokens: group.tokens,
          count: group.count,
          scope: "session",
        });
      }

      return items.sort((a, b) => b.tokens - a.tokens);
    }

    const CAP_TABS = [
      { key: "skills", label: "技能" },
      { key: "mcp", label: "MCP" },
      { key: "plugins", label: "插件" },
    ];
    // 会话层也覆盖系统提示段与系统工具：只在这两页做开关，正文改写仍在左侧项目页。
    const SCOPE_TABS = [
      { key: "sections", label: "提示段" },
      { key: "tools", label: "工具" },
    ];

    /**
     * 会话内的那一层：默认收起，点胶囊才浮出来。
     * 上半是「这次请求发了什么」，下半（技能/MCP/插件）是「这个项目能用什么」。
     */
    function ChipPopover() {
      const active = useOverlay();
      const { open, sessionId, input, rect } = active;
      const [state, setState] = useState(null);
      const [session, setSession] = useState(null);
      const [tab, setTab] = useState("usage");
      const [checked, setChecked] = useState({});
      const [preset, setPreset] = useState(false);
      const [note, setNote] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [done, setDone] = useState("");
      const [loading, setLoading] = useState(false);
      const [aiOpen, setAiOpen] = useState(false);
      const [inlineAi, setInlineAi] = useState(null);
      // 全局筛选：只作用于除概览外的页签，切页不丢；关闭弹窗时清空。
      const [popQuery, setPopQuery] = useState("");
      const [popStatus, setPopStatus] = useState("all");
      // 弹窗高度以「概览」为基准：切到技能/MCP/工具等短列表时不再跟着内容缩。
      const popRef = useRef(null);
      const [fixedHeight, setFixedHeight] = useState(0);
      const [sumHint, setSumHint] = useState(false);
      const sumHintRef = useRef(null);
      // 六个页签固定单行，放不下就横向滑动，不再做「先换行、再滚动」的两套逻辑。
      const load = useCallback(async () => {
        if (!sessionId) return;
        setLoading(true);
        try {
          const data = await request(null, { sessionId });
          setState(data);
          try {
            const result = await request(null, { action: "session", sessionId });
            setSession(result.session ?? null);
          } catch (err) {
            setSession({ ok: false, error: messageOf(err) });
          }
          setError("");
        } catch (err) {
          setError(messageOf(err));
        } finally {
          setLoading(false);
        }
      }, [sessionId]);

      useEffect(() => {
        if (!open) return;
        setTab("usage");
        setAiOpen(false);
        setSumHint(false);
        setChecked({});
        setPreset(false);
        setDone("");
        setNote("");
        setPopQuery("");
        setPopStatus("all");
        void load();
      }, [open, load]);

      useEffect(() => {
        if (!open) {
          setFixedHeight(0);
          return;
        }
        // 只量一次「概览」的自然高度：量过之后高度固定，切页不再跟着内容缩。
        // state 还没到就先不量，避免把「载入中」的矮高度锁死。
        if (tab !== "usage" || !state || fixedHeight) return;
        const el = popRef.current;
        if (!el) return;
        const frame = requestAnimationFrame(() => {
          const measured = Math.max(240, Math.min(maxHeight, Math.round(el.offsetHeight)));
          // 内容区别太矮：概览自然高度偏小时，至少给到 520（受视口 maxHeight 限制）。
          setFixedHeight(Math.max(measured, Math.min(maxHeight, 520)));
        });
        return () => cancelAnimationFrame(frame);
      }, [open, tab, state, fixedHeight]);

      useEffect(() => {
        setSumHint(false);
      }, [tab]);

      useEffect(() => {
        if (!open) {
          setPopQuery("");
          setPopStatus("all");
        }
      }, [open]);

      useEffect(() => {
        if (!sumHint) return undefined;
        const onDown = (event) => {
          if (!sumHintRef.current?.contains(event.target)) setSumHint(false);
        };
        const onKey = (event) => {
          if (event.key === "Escape") setSumHint(false);
        };
        document.addEventListener("pointerdown", onDown, true);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("pointerdown", onDown, true);
          document.removeEventListener("keydown", onKey);
        };
      }, [sumHint]);

      const act = useCallback(
        async (payload) => {
          setBusy(true);
          setError("");
          try {
            const result = await request(payload);
            await load();
            return result;
          } catch (err) {
            setError(messageOf(err));
            return null;
          } finally {
            setBusy(false);
          }
        },
        [load],
      );

      const askInline = async (itemId, name) => {
        setInlineAi({ itemId, name, loading: true, suggestion: null, error: "" });
        const result = await act({ action: "aiSuggest", scope: "item", itemId, writeScope: "session" });
        const suggestion = result?.suggestion ?? null;
        setInlineAi((current) => current && current.itemId === itemId
          ? { ...current, loading: false, suggestion, error: suggestion ? "" : (result?.message || "没有拿到建议") }
          : current);
      };
      const applyInline = async () => {
        const current = inlineAi;
        const suggestion = current?.suggestion;
        if (!suggestion) return;
        const item = suggestion.items.find((entry) => entry.id === current.itemId);
        if (!item) return;
        const result = await act({ action: "aiApply", suggestionId: suggestion.id, itemIds: [item.id], confirm: true });
        if (result?.ok) setInlineAi({ ...current, suggestion: null, applied: true, undoToken: result.undoToken || "" });
      };
      const undoInline = async () => {
        if (!inlineAi?.undoToken) return;
        const result = await act({ action: "aiUndo", undoToken: inlineAi.undoToken });
        if (result?.ok) setInlineAi(null);
      };
      const inlineView = () => {
        if (!inlineAi) return null;
        const suggestion = inlineAi.suggestion;
        const item = suggestion?.items?.find((entry) => entry.id === inlineAi.itemId);
        return h("div", { className: "cc-ai-inline" },
          h("div", { className: "cc-ai-inline-head" },
            h("b", null, inlineAi.name || inlineAi.itemId),
            h("span", { className: "cc-ai-note" }, "单条建议 · 只写本会话"),
            h("button", { type: "button", className: "cc-link", onClick: () => setInlineAi(null) }, "关闭"),
          ),
          inlineAi.loading ? h("div", { className: "cc-ai-note" }, "分析这一项…")
            : inlineAi.applied ? h("div", { className: "cc-ai-inline-row" },
                h("span", { className: "cc-alert is-ok" }, "已应用"),
                inlineAi.undoToken ? h("button", { type: "button", className: "cc-btn is-ghost is-mini", onClick: () => void undoInline() }, "撤销") : null,
              )
            : suggestion && item ? h("div", { className: "cc-ai-inline-row" },
                h("span", { className: `cc-ai-action is-${item.action}` }, item.action === "hide" ? "隐藏" : item.action === "brief" ? "简介" : item.action === "rewrite" ? "改写" : "保留"),
                h("span", { className: "cc-ai-why" }, item.reason || ""),
                item.savedTokens ? h("span", { className: "cc-ai-save" }, `−${formatTokens(item.savedTokens)}`) : null,
                h("button", { type: "button", className: "cc-btn is-mini", disabled: busy, onClick: () => void applyInline() }, "应用这一项"),
              )
            : h("div", { className: "cc-ai-warn" }, inlineAi.error || suggestion?.warnings?.[0] || "这一项没有可执行建议。"),
        );
      };

      const mode = useMemo(() => {
        if (!state) return null;
        return state.modes.find((item) => item.id === state.activeModeId) ?? state.modes[0];
      }, [state]);

      const modules = useMemo(
        () => collectModules(state, session, mode, state?.projected?.removed),
        [state, session, mode],
      );

      // 默认勾上最占地方的两块（通常是「工具结果」和「系统消息副本」）：
      // 用户点开胶囊直接按「发送压缩指令」就能压到真正的大头。
      useEffect(() => {
        if (!open || preset || modules.length === 0) return;
        setChecked(Object.fromEntries(modules.slice(0, 2).map((item) => [item.key, true])));
        setPreset(true);
      }, [open, preset, modules]);
      const selected = modules.filter((item) => checked[item.key]);
      const selectedTokens = selected.reduce((sum, item) => sum + item.tokens, 0);

      const projectId = state?.activeProjectId ?? "workspace";
      const project = state?.projects?.find((item) => item.id === projectId) ?? null;
      // 胶囊里的技能/MCP/插件开关是「本会话」层：叠在项目继承之上，不写回项目。
      const sessionCaps = state?.sessionCaps ?? {};
      const caps = { ...(project?.resolvedCaps ?? {}), ...sessionCaps };
      const aiEnabled = state?.ai?.enabled === true;
      const kinds = state?.capabilities ?? {};
      // 系统提示段自己没有 capKey，按能力目录反查「这段属于哪个能力」。
      const sectionCaps = {};
      for (const entry of [...(kinds.skills ?? []), ...(kinds.mcp ?? []), ...(kinds.plugins ?? [])]) {
        for (const name of entry.sectionNames ?? []) sectionCaps[name] = entry.key;
      }
      const capKeyOf = (item, kind) =>
        item?.capKey ?? (kind === "sections" ? sectionCaps[item?.name] : null);
      const sessionRules = state?.sessionRules ?? { sections: {}, tools: {} };
      const setCap = (key, enabled) =>
        act({ action: "setCap", scope: "session", sessionId, key, enabled });
      const setScopeRule = (kind, name, patch) =>
        act({ action: "setSessionRule", sessionId, kind, name, patch });

      const compaction = state?.compaction ?? { available: false, via: null, reason: "" };
      const lastCompact = state?.lastCompact ?? null;
      const autoCompact = state?.autoCompact ?? { enabled: true, ratio: 0.8 };
      const autoRatioPct = Math.round((Number(autoCompact.ratio) || 0.8) * 100);
      const autoCompactRow = h(
        "div",
        { className: "cc-auto" },
        h("label", { className: "cc-auto-check" },
          h("input", {
            type: "checkbox",
            checked: autoCompact.enabled !== false,
            onChange: (event) => void act({ action: "setAutoCompact", enabled: event.target.checked }),
          }),
          "窗口占用到"),
        h("input", {
          key: `auto-${autoRatioPct}`,
          type: "number",
          min: 5,
          max: 95,
          step: 5,
          defaultValue: autoRatioPct,
          className: "cc-auto-num",
          disabled: autoCompact.enabled === false,
          onBlur: (event) => {
            const pct = Number(event.target.value);
            if (!Number.isFinite(pct)) return;
            const clamped = Math.min(95, Math.max(5, Math.round(pct)));
            // 输入 3% 这类越界值时，先把框里显示的数字拉回下限，再提交。
            event.target.value = String(clamped);
            if (clamped === autoRatioPct) return;
            void act({ action: "setAutoCompact", ratio: clamped / 100 });
          },
        }),
        h("span", { className: "cc-muted" }, "% 自动压缩（空闲时执行，不用手点）"),
      );
      const lastCompactLine = (() => {
        if (!lastCompact) return null;
        if (lastCompact.running) {
          return h("p", { className: "cc-hint is-tight" }, `正在压缩（${Math.round((lastCompact.ratio ?? 0) * 100)}% 窗口）…`);
        }
        if (lastCompact.queued) {
          return h("p", { className: "cc-hint is-tight" },
            `已排队：这一轮结束后自动压缩（现在窗口 ${Math.round((lastCompact.ratio ?? 0) * 100)}%）。`);
        }
        if (lastCompact.error) {
          return h("p", { className: "cc-hint is-tight" }, `上次压缩没成功：${lastCompact.error}`);
        }
        const summary = compactSummary(lastCompact);
        if (!summary) return null;
        return h("p", { className: "cc-hint is-tight" }, summary);
      })();

      const compactNow = async () => {
        setBusy(true);
        setError("");
        setDone("");
        if (!compaction.available) {
          try {
            await request({
              action: "inject",
              sessionId,
              mode: "steer",
              groups: selected.length > 0 ? selected.map((item) => ({ key: item.key, label: item.label, tokens: item.tokens })) : undefined,
            });
            setDone("已发出压缩指令（steer）：模型会立刻用 compress 折叠这些模块。");
            setChecked({});
            await load();
          } catch (err) {
            setError(messageOf(err));
          } finally {
            setBusy(false);
          }
          return;
        }
        try {
          const result = await request({ action: "compact", sessionId });
          const info = result?.compact ?? {};
          if (info.queued) {
            setDone(result?.message || "本轮还在跑，已经排队：结束后自动压缩。");
            setChecked({});
            await load();
            return;
          }
          if (!info.compacted) {
            setDone("宿主没有找到可以安全压缩的区间（可能刚压缩过，或者历史太短）。");
          } else {
            const saved = Math.max(0, (info.beforeSurface ?? 0) - (info.afterSurface ?? 0));
            setDone(
              `已压缩：折叠 ${formatTokens(info.shadowedTokens ?? 0)} tokens，窗口 ${formatTokens(info.beforeSurface ?? 0)} → ${formatTokens(info.afterSurface ?? 0)}（少 ${formatTokens(saved)}）。`,
            );
          }
          setChecked({});
          await load();
        } catch (err) {
          setError(messageOf(err));
        } finally {
          setBusy(false);
        }
      };

      const compose = async (send) => {
        setBusy(true);
        setError("");
        try {
          const groups = selected.map((item) => ({
            key: item.key,
            label: item.label,
            tokens: item.tokens,
            count: item.count,
          }));
          if (send) {
            await request({ action: "inject", sessionId, note, groups });
            setDone("已发送：模型会先给压缩摘要，再继续手上的活。");
            setChecked({});
            return;
          }
          const result = await request({ action: "prompt", sessionId, note, groups });
          const text = String(result?.prompt?.text ?? "");
          if (!text) throw new Error("提示词是空的");
          let placed = false;
          if (input && typeof input.captureInsertion === "function" && typeof input.insertText === "function") {
            const span = input.captureInsertion();
            const at = Number(span?.start ?? span?.from ?? 0);
            placed = input.insertText(at > 0 ? `\n\n---\n\n${text}` : text, span) === true;
          }
          if (!placed && input && typeof input.setDraft === "function") {
            input.setDraft(text);
            placed = true;
          }
          if (!placed) throw new Error("拿不到会话输入框，没法把提示词写进去");
          overlay.set({ open: false });
        } catch (err) {
          setError(messageOf(err));
        } finally {
          setBusy(false);
        }
      };

      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") overlay.set({ open: false });
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open]);

      if (!open) return null;

      const vw = typeof window === "undefined" ? 1200 : window.innerWidth || 1200;
      const vh = typeof window === "undefined" ? 800 : window.innerHeight || 800;
      const width = Math.min(430, vw - 24);
      const left = rect ? Math.min(Math.max(12, rect.left), vw - width - 12) : 20;
      const bottom = rect ? Math.max(12, vh - rect.top + 10) : 20;
      const maxHeight = Math.max(240, Math.min(560, vh - bottom - 16));

      const used = session?.ok
        ? (session.pressure?.pressureTokens ?? session.windowTokens ?? session.total)
        : null;
      const contextWindow = session?.pressure?.contextWindow ?? null;
      const promptItems = modules.filter((item) => item.scope === "prompt");
      const sessionItems = modules.filter((item) => item.scope === "session");
      const sumOf = (list) => list.reduce((sum, item) => sum + item.tokens, 0);
      const sessionSum = sumOf(sessionItems);
      const projected = state?.projected ?? null;
      const rawPromptSum = sumOf(promptItems);
      const promptSum = projected?.total ?? rawPromptSum;
      const savedPrompt = projected?.removedTokens ?? 0;
      // 只数界面上真的会列出来的项：0 token 的空段不参与页签计数，别让概览多数出两个。
      const visibleRemovedSections = (projected?.removed?.sections ?? []).filter((name) =>
        (state?.prompt?.sections ?? []).some((item) => item.name === name && (item.tokens ?? 0) > 0),
      ).length;
      const removedCount = visibleRemovedSections + (projected?.removed?.tools?.length ?? 0);
      const nextTurn = used == null ? null : used + promptSum;
      const sumHintText = `当前窗口是胶囊与 DSH 显示的口径（会话已累积 ≈${formatTokens(sessionSum)}）；每次重发是下一轮额外要发的系统提示与工具定义`
        + (removedCount > 0 ? `，已扣掉 ${removedCount} 个隐藏段/工具（≈${formatTokens(savedPrompt)}）` : "")
        + `。两者相加只是下一轮的粗估，不是现在的占用。`;

      const tabButton = (key, label, badge) =>
        h(
          "button",
          {
            key,
            type: "button",
            role: "tab",
            "aria-selected": tab === key ? "true" : "false",
            className: "cc-ptab",
            onClick: () => setTab(key),
          },
          h("span", null, label),
          badge ? h("span", { className: "cc-badge" }, badge) : null,
        );

      const pickRow = (item) =>
        h(
          "label",
          { key: item.key, className: `cc-pick-row${checked[item.key] ? " is-on" : ""}` },
          h("input", {
            type: "checkbox",
            checked: Boolean(checked[item.key]),
            onChange: (event) => setChecked((current) => ({ ...current, [item.key]: event.target.checked })),
          }),
          h("span", { className: "cc-pick-label" }, item.label),
          item.count ? h("span", { className: "cc-muted" }, `${item.count} 项`) : null,
          h("span", { className: "cc-pick-token" }, `≈${formatTokens(item.tokens)}`),
        );

      // 系统提示每回合都会以 append 的方式再记一条完整副本（billion-context 折叠后锚点丢失，
      // DSH 无法 replace 只能 append），所以「系统消息」这一栏里大多是重复内容，得让用户看得见。
      const sysGroup = (session?.groups ?? []).find((item) => item.key === "systemMsgs");
      const sessionHint =
        sysGroup && sysGroup.count > 2
          ? `计量口径，和 DSH 自带的上下文统计一致；其中系统消息 ${sysGroup.count} 条 ≈${formatTokens(sysGroup.tokens)} 基本是每回合追加的整份提示副本。`
          : "计量口径，和 DSH 自带的上下文统计一致。";

      const pickGroup = (title, hint, list) =>
        list.length === 0
          ? null
          : h(
              "div",
              { className: "cc-pick-group" },
              h(
                "div",
                { className: "cc-pick-head" },
                h("span", { className: "cc-pick-title" }, title),
                h("span", { className: "cc-muted" }, `${list.length} 项 · ≈${formatTokens(sumOf(list))}`),
              ),
              hint ? h("div", { className: "cc-pick-hint" }, hint) : null,
              h("div", { className: "cc-pick" }, list.map(pickRow)),
            );

      const usageView = h(
        "div",
        null,
        modules.length === 0
          ? h("div", { className: "cc-empty is-small" }, loading ? "正在读取模块…" : "还没有读到上下文模块。")
          : h(
              "div",
              null,
              used == null
                ? null
                : h(
                    "div",
                    { className: "cc-sum" },
                    h(
                      "span",
                      { className: "cc-sum-first" },
                      h(
                        "span",
                        { className: "cc-info-wrap", ref: sumHintRef },
                        h(
                          "button",
                          {
                            type: "button",
                            className: `cc-info${sumHint ? " is-open" : ""}`,
                            "aria-label": "说明",
                            "aria-expanded": sumHint ? "true" : "false",
                            onPointerEnter: (event) => {
                              if (event.pointerType === "mouse") setSumHint(true);
                            },
                            onPointerLeave: (event) => {
                              if (event.pointerType === "mouse") setSumHint(false);
                            },
                            onClick: (event) => {
                              event.stopPropagation();
                              setSumHint(true);
                            },
                          },
                          "i",
                        ),
                        sumHint ? h("span", { className: "cc-info-tip", role: "tooltip" }, sumHintText) : null,
                      ),
                      "当前窗口 ",
                      h("b", null, formatTokens(used)),
                    ),
                    h("span", null, "每次重发 ≈", h("b", null, formatTokens(promptSum))),
                    h("span", null, "下一轮预计 ≈", h("b", null, formatTokens(nextTurn))),
                  ),
              h(
                "div",
                { className: "cc-pick-groups" },
                pickGroup("会话已累积", sessionHint, sessionItems),
                pickGroup("每次请求都会重发", "按文本估算，其中工具定义占大头；已按隐藏项扣减。", promptItems),
              ),
            ),
        h(
          "label",
          { className: "cc-field" },
          h("span", { className: "cc-field-label" }, "额外要求（可选）"),
          h("input", {
            className: "cc-input",
            value: note,
            placeholder: "例如：只保留结论与文件路径，不要日志全文",
            onChange: (event) => setNote(event.target.value),
          }),
        ),
      );

      const capView = (kind) => {
        const entries = kinds[kind] ?? [];
        const needle = popQuery.trim().toLowerCase();
        const searched = needle
          ? entries.filter((entry) =>
              `${entry.id} ${entry.key} ${entry.summary ?? ""}`.toLowerCase().includes(needle),
            )
          : entries;
        const shown = searched.filter((entry) => statusMatches(popStatus, modeOfCaps(caps, entry.key) === "on"));
        return h(
          "div",
          null,
          inlineView(),
          entries.length === 0
            ? h(
                "div",
                { className: "cc-empty is-small" },
                kind === "skills"
                  ? SKILL_EMPTY_TEXT
                  : "这一类还没有可配置的条目。",
              )
            : shown.length === 0
              ? h("div", { className: "cc-empty is-small" }, "没有匹配的条目。")
              : h(
                  "div",
                  { className: "cc-cap-list" },
                      shown.map((entry) => {
                        const readOnly = entry.readOnly === true;
                        const value = readOnly ? "on" : modeOfCaps(caps, entry.key);
                        const own = !readOnly && Object.prototype.hasOwnProperty.call(sessionCaps, entry.key);
                        return h(
                          "div",
                          { key: entry.key, className: `cc-cap is-${value} is-compact${readOnly ? " is-readonly" : ""}` },
                          h(
                            "div",
                            { className: "cc-cap-main" },
                            h(
                              "div",
                              { className: "cc-cap-title" },
                              h("span", { className: "cc-cap-name", title: entry.summary || entry.key }, entry.id),
                              readOnly ? h("span", { className: "cc-tag" }, "磁盘") : null,
                              own ? h("span", { className: "cc-tag" }, "本会话") : null,
                            ),
                          ),
                          h("span", { className: "cc-num" }, `≈${formatTokens(entry.tokens)}`),
                          readOnly
                            ? h("span", {
                                className: "cc-seg is-readonly",
                                title: "来自磁盘技能目录的只读条目；没有可写的目录段",
                              }, "只读")
                            : h(CapSeg, { mode: value, busy, onSet: (next) => setCap(entry.key, next) }),
                          aiEnabled && !readOnly
                            ? h("button", {
                                type: "button",
                                className: "cc-link is-icon",
                                title: "让 AI 只分析这一项",
                                disabled: busy,
                                onClick: () => void askInline(`cap:${entry.key}`, entry.id),
                              }, "AI")
                            : null,
                          own
                            ? h(
                                "button",
                                {
                                  type: "button",
                                  className: "cc-link is-icon",
                                  title: "撤掉本会话覆盖，回到项目继承来的档位",
                                  disabled: busy,
                                  onClick: () => setCap(entry.key, null),
                                },
                                "↺",
                              )
                            : null,
                        );
                      }),
                    ),
          h(
            "div",
            { className: "cc-pop-note" },
            shown.some((entry) => entry.readOnly)
              ? `只读技能来自磁盘技能目录，没有可写的目录段；安装或启用懒工具箱后会切换为可调列表。${entries.some((entry) => !entry.readOnly) ? "其余条目仍只作用于本会话。" : ""}`
              : "只作用于本会话，不改项目/工作区；加载 = 正文与工具都发，简介 = 只留一行说明，隐藏 = 连简介都不发，调用要审批。",
          ),
        );
      };

      // 会话层的系统提示段 / 系统工具：继承项目规则，叠上本会话覆盖。
      // 统计口径要跟「实际发不发」一致：能力被关掉（capOff）的项也算关闭，否则会出现 147/147。
      const scopeData = (kind) => {
        const all = kind === "sections" ? state?.prompt?.sections ?? [] : state?.prompt?.tools ?? [];
        const own = sessionRules[kind] ?? {};
        const merged = { ...(project?.resolved?.[kind] ?? {}), ...own };
        const rows = all.filter((item) => kind === "tools" || (item.tokens ?? 0) > 0 || own[item.name]);
        let on = 0;
        let saved = 0;
        for (const item of rows) {
          const enabled = merged[item.name]?.enabled !== false;
          const key = capKeyOf(item, kind);
          const capMode = key ? modeOfCaps(caps, key) : "on";
          if (enabled && capMode === "on") on += 1;
          else saved += item.tokens ?? 0;
        }
        return { all, own, merged, rows, on, saved };
      };
      const scopeView = (kind) => {
        const { own, merged, rows } = scopeData(kind);
        const needle = popQuery.trim().toLowerCase();
        const enabledOf = (item) => merged[item.name]?.enabled !== false;
        const actualOn = (item) => {
          if (!enabledOf(item)) return false;
          const key = capKeyOf(item, kind);
          return !key || modeOfCaps(caps, key) === "on";
        };
        const searched = needle
          ? rows.filter((item) => item.name.toLowerCase().includes(needle) || (item.preview ?? "").toLowerCase().includes(needle))
          : rows;
        const items = searched.filter((item) => statusMatches(popStatus, actualOn(item)));
        return h(
          "div",
          null,
          inlineView(),
          rows.length === 0
            ? h("div", { className: "cc-empty is-small" }, kind === "sections" ? "还没有可读的系统提示段。" : "工具表还没读出来。")
            : items.length === 0
              ? h("div", { className: "cc-empty is-small" }, "没有匹配的内容。")
              : h(
                "div",
                { className: "cc-list" },
                items.map((item) => {
                  const enabled = enabledOf(item);
                  const isOwn = Object.prototype.hasOwnProperty.call(own, item.name);
                  const capKey = capKeyOf(item, kind);
                  const capMode = capKey ? modeOfCaps(caps, capKey) : "on";
                  const capOff = capMode !== "on";
                  const tokens = enabled && !capOff ? item.tokens ?? 0 : 0;
                  return h(
                    "div",
                    { key: item.name, className: `cc-row${enabled && !capOff ? "" : " is-off"}`, title: capOff ? `所属能力 ${item.capKey} 被关闭` : undefined },
                    h(Switch, {
                      checked: enabled && !capOff,
                      disabled: busy || capOff,
                      title: capOff ? `所属能力 ${capKey} 被关闭，先在上面的能力页打开` : undefined,
                      onChange: (next) => setScopeRule(kind, item.name, { enabled: next }),
                    }),
                    h(
                      "div",
                      { className: "cc-row-main" },
                      h(
                        "div",
                        { className: "cc-row-title" },
                        h("code", { className: "cc-name" }, item.name),
                        capOff ? h("span", { className: `cc-tag is-${capMode}` }, capMode === "hidden" ? "隐藏" : "简介") : null,
                        isOwn ? h("span", { className: "cc-tag" }, "本会话") : null,
                      ),
                      h("div", { className: "cc-row-preview" }, item.preview || (item.description ?? "") || "（空）"),
                    ),
                    h("span", { className: "cc-num" }, `≈${formatTokens(tokens)}`),
                    h(
                      "div",
                      { className: "cc-row-actions" },
                      aiEnabled
                        ? h("button", {
                            type: "button",
                            className: "cc-link is-icon",
                            title: "让 AI 只分析这一项",
                            disabled: busy,
                            onClick: () => void askInline(`${kind === "sections" ? "section" : "tool"}:${item.name}`, item.name),
                          }, "AI")
                        : null,
                      isOwn
                        ? h(
                            "button",
                            {
                              type: "button",
                              className: "cc-link is-icon",
                              title: "撤掉本会话覆盖，回到项目继承来的规则",
                              disabled: busy,
                              onClick: () => setScopeRule(kind, item.name, null),
                            },
                            "↺",
                          )
                        : null,
                    ),
                  );
                }),
              ),
          h(
            "div",
            { className: "cc-pop-note" },
            "只作用于本会话，不改项目/工作区；这里只做开关，正文改写请到左侧项目页的「系统提示」/「系统工具」。",
          ),
        );
      };

      // 所有子页共用同一行标题：位置、高度、左右结构都固定，只有文字和动作随页签变。
      const tabTitle = { usage: "概览", skills: "技能", mcp: "MCP", plugins: "插件", sections: "提示段", tools: "工具" }[tab] ?? "概览";
      let pageMeta = "";
      if (tab === "skills" || tab === "mcp" || tab === "plugins") {
        const entries = kinds[tab] ?? [];
        const loaded = entries.filter((entry) => modeOfCaps(caps, entry.key) === "on").length;
        pageMeta = `本会话 · 继承项目 ${project?.name ?? "工作区"} · ${loaded}/${entries.length} 已加载`;
      } else if (tab === "sections" || tab === "tools") {
        const data = scopeData(tab);
        pageMeta = `本会话 · 继承项目 ${project?.name ?? "工作区"} · ${data.on}/${data.rows.length} 生效`
          + (data.saved > 0 ? ` · 少发 ≈${formatTokens(data.saved)}` : "");
      }

      const capKind = tab === "skills" || tab === "mcp" || tab === "plugins" ? tab : null;
      const capEntries = capKind ? kinds[capKind] ?? [] : [];
      const capActions = capKind && capEntries.length > 0
        ? h(
            "div",
            { className: "cc-cap-actions" },
            h("button", { type: "button", className: "cc-btn is-mini", disabled: busy, onClick: () => capEntries.forEach((entry) => setCap(entry.key, true)) }, "全开"),
            h("button", { type: "button", className: "cc-btn is-mini", disabled: busy, onClick: () => capEntries.forEach((entry) => setCap(entry.key, false)) }, "全关"),
          )
        : null;

      return h(
        "div",
        {
          className: "cc-pop-layer",
          role: "presentation",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) overlay.set({ open: false });
          },
        },
        h(
          "div",
          {
            className: "cc-page cc-pop",
            role: "dialog",
            "aria-modal": "false",
            "aria-label": "本会话上下文",
            ref: popRef,
            style: {
              left,
              bottom,
              width,
              maxHeight,
              height: fixedHeight ? Math.min(fixedHeight, maxHeight) : undefined,
            },
          },
          h(
            "div",
            { className: "cc-pop-head" },
            h(
              "div",
              { className: "cc-pop-title" },
              h("b", null, used == null ? "本会话上下文" : `≈${formatTokens(used)}`),
              h("span", { className: "cc-muted" },
                used == null ? "还没读到计量" : `窗口占用${contextWindow ? ` · 共 ${formatTokens(contextWindow)}` : ""}`),
            ),
            h("div", { className: "cc-row-gap" },
              h("button", { type: "button", className: `cc-btn is-ghost is-mini${aiOpen ? " is-on" : ""}`, disabled: loading, onClick: () => setAiOpen((value) => !value) }, "AI"),
              h("button", { type: "button", className: "cc-btn is-ghost is-mini", disabled: loading, onClick: () => void load() }, loading ? "…" : "刷新"),
              h("button", { type: "button", className: "cc-btn is-ghost is-mini", onClick: () => overlay.set({ open: false }) }, "关闭"),
            ),
          ),

          h(
            "nav",
            { className: "cc-ptabs", role: "tablist" },
            tabButton("usage", "概览", `${sessionItems.length + promptItems.length}`),
            CAP_TABS.map((item) => tabButton(item.key, item.label, `${(kinds[item.key] ?? []).length}`)),
            SCOPE_TABS.map((item) => {
              const data = scopeData(item.key);
              return tabButton(item.key, item.label, `${data.on}/${data.rows.length}`);
            }),
          ),

          tab === "usage"
            ? null
            : h(
                "div",
                { className: "cc-pop-page-head" },
                h("span", { className: "cc-pop-page-title" }, tabTitle),
                h("span", { className: "cc-pop-page-meta", title: pageMeta }, pageMeta),
              ),

          tab === "usage"
            ? null
            : h(
                "div",
                { className: "cc-pop-toolbar" },
                h(
                  "div",
                  { className: "cc-pop-search" },
                  h("input", {
                    className: "cc-input",
                    type: "search",
                    value: popQuery,
                    placeholder: "筛选技能、MCP、插件、提示段、工具…",
                    "aria-label": "筛选全部内容",
                    onChange: (event) => setPopQuery(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setPopQuery("");
                      }
                    },
                  }),
                  popQuery
                    ? h(
                        "button",
                        {
                          type: "button",
                          className: "cc-pop-search-clear",
                          title: "清除筛选",
                          "aria-label": "清除筛选",
                          onClick: () => setPopQuery(""),
                        },
                        "×",
                      )
                    : null,
                ),
                h(StatusFilter, { value: popStatus, onChange: setPopStatus }),
                capActions,
              ),

          h(
            "div",
            { className: `cc-pop-body${tab === "usage" && !aiOpen ? " is-usage" : ""}` },
            aiOpen
              ? h(AiBlock, { scope: "session", sessionId, state, act, busy, title: "AI 优化本会话" })
              : null,
            error ? h("div", { className: "cc-alert" }, error) : null,
            done ? h("div", { className: "cc-alert is-ok" }, done) : null,
            !aiOpen && tab === "usage" ? usageView : null,
            !aiOpen && tab === "usage" && !compaction.available
              ? h("p", { className: "cc-hint is-tight" }, compaction.reason || "宿主压缩不可用，改用 steer 指令。")
              : null,
            !aiOpen && tab === "usage" ? lastCompactLine : null,
            !aiOpen && tab === "usage" ? autoCompactRow : null,
            !aiOpen && tab === "skills" ? capView("skills") : null,
            !aiOpen && tab === "mcp" ? capView("mcp") : null,
            !aiOpen && tab === "plugins" ? capView("plugins") : null,
            !aiOpen && tab === "sections" ? scopeView("sections") : null,
            !aiOpen && tab === "tools" ? scopeView("tools") : null,
          ),

          tab === "usage"
            ? h(
                "div",
                { className: "cc-pop-foot" },
                h(
                  "span",
                  { className: "cc-muted" },
                  selected.length === 0
                    ? (compaction.available
                      ? "立即压缩不用勾选，宿主自己挑区间"
                      : "本 profile 走 steer 指令：不勾就用默认四块，勾了就只压这些")
                    : `已勾选 ${selected.length} 块 · ≈${formatTokens(selectedTokens)}（只影响「写入输入框」）`,
                ),
                h(
                  "div",
                  { className: "cc-row-gap" },
                  h(
                    "button",
                    { type: "button", className: "cc-btn", disabled: busy || !sessionId, onClick: () => void compose(false) },
                    "写入输入框",
                  ),
                  h(
                    "button",
                    { type: "button", className: "cc-btn is-primary", disabled: busy || !sessionId, onClick: () => void compactNow() },
                    busy ? "压缩中…" : (compaction.available ? "立即压缩" : "发送压缩指令"),
                  ),
                ),
              )
            : null,
        ),
      );
    }

    /* ------------------------------------------------------------------ 样式 */

    const CSS = `
/* ---------- 基础：一个可滚动的文档，而不是一叠卡片 ---------- */
.cc-page{
  --cc-line:var(--dsw-alias-border-l2,#e6e7eb);
  --cc-soft:var(--dsw-alias-separator,rgba(0,0,0,.055));
  --cc-ink:var(--dsw-alias-label-primary,#1b1b1f);
  --cc-ink2:var(--dsw-alias-label-secondary,#5b616b);
  --cc-ink3:var(--dsw-alias-label-tertiary,#8b9099);
  --cc-bg:var(--dsw-alias-bg-base,#fff);
  --cc-hover:var(--dsw-alias-interactive-bg-hover,#f2f3f6);
  --cc-on:var(--dsw-alias-state-business-primary,#3b6ef0);
  --cc-warn:var(--dsw-alias-state-warning-primary,#a97a08);
  --cc-err:var(--dsw-alias-state-error-primary,#c0392b);
  height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  background:var(--cc-bg);color:var(--cc-ink);
  font-size:12.5px;line-height:1.5;
  font-variant-numeric:tabular-nums;
  scrollbar-width:thin;
  scrollbar-color:color-mix(in srgb,var(--cc-ink3) 45%,transparent) transparent;
}
.cc-page *{box-sizing:border-box}
.cc-page ::selection{background:color-mix(in srgb,var(--cc-on) 24%,transparent)}
.cc-page::-webkit-scrollbar{width:10px;height:10px}
.cc-page::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--cc-ink3) 38%,transparent);border:3px solid transparent;background-clip:content-box;border-radius:99px}
.cc-page::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--cc-ink3) 62%,transparent);background-clip:content-box}
.cc-page :focus-visible{outline:2px solid color-mix(in srgb,var(--cc-on) 70%,transparent);outline-offset:2px}
.cc-muted{color:var(--cc-ink3);font-size:11.5px}
.cc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* ---------- 顶部：一个粘住的仪表条 ---------- */
.cc-top{
  position:sticky;top:0;z-index:6;
  padding:14px 26px 0;
  background:color-mix(in srgb,var(--cc-bg) 92%,transparent);
  backdrop-filter:blur(10px);
  border-bottom:1px solid var(--cc-soft);
}
.cc-top-main{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.cc-title{margin:0;font-size:14px;font-weight:650;letter-spacing:-.012em}
.cc-top-total{margin-left:auto;display:flex;align-items:baseline;gap:7px}
.cc-top-total b{font-size:15px;font-weight:650;letter-spacing:-.01em}
.cc-top-total span{font-size:11px;color:var(--cc-ink3)}
.cc-strip{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:9px}
.cc-strip .cc-muted{margin-right:auto}
.cc-mode{display:flex;align-items:center;gap:6px}
.cc-select{
  appearance:none;border:1px solid var(--cc-line);border-radius:7px;background:var(--cc-bg);
  color:var(--cc-ink);font:inherit;font-size:12px;padding:4px 24px 4px 8px;cursor:pointer;
  background-image:linear-gradient(45deg,transparent 50%,var(--cc-ink3) 50%),linear-gradient(135deg,var(--cc-ink3) 50%,transparent 50%);
  background-position:calc(100% - 12px) 53%,calc(100% - 8px) 53%;background-size:4px 4px,4px 4px;background-repeat:no-repeat;
}
.cc-select:hover{border-color:color-mix(in srgb,var(--cc-ink3) 55%,transparent)}
.cc-status-select{flex:0 0 auto;height:26px;font-size:11.5px;padding:3px 20px 3px 7px;background-position:calc(100% - 10px) 53%,calc(100% - 6px) 53%}
.cc-pop-toolbar .cc-status-select{height:26px}
.cc-menu{position:relative}
.cc-menu>summary{
  list-style:none;cursor:pointer;font-size:11.5px;color:var(--cc-ink2);
  padding:3px 8px;border-radius:6px;border:1px solid transparent;
}
.cc-menu>summary::-webkit-details-marker{display:none}
.cc-menu>summary:hover{background:var(--cc-hover)}
.cc-menu[open]>summary{border-color:var(--cc-line);background:var(--cc-hover)}
.cc-menu-body{
  position:absolute;right:0;top:calc(100% + 6px);z-index:9;min-width:230px;
  display:flex;flex-direction:column;gap:9px;padding:11px;
  background:var(--cc-bg);border:1px solid var(--cc-line);border-radius:10px;
  box-shadow:0 12px 28px -12px rgba(0,0,0,.28);
}
.cc-menu-body .cc-row-gap{display:flex;gap:6px}
.cc-menu-note{font-size:11px;color:var(--cc-ink3)}

/* 构成条：整条是一个比例尺，标签在下面一行 */
.cc-meter-line{display:flex;align-items:center;gap:12px;margin:11px 0 9px;flex-wrap:wrap}
.cc-meter{display:flex;flex:1 1 260px;height:6px;border-radius:99px;overflow:hidden;background:var(--cc-soft);min-width:180px}
.cc-meter span{display:block;height:100%;min-width:2px;transition:width .22s cubic-bezier(.2,.8,.2,1)}
.cc-meter .is-sections{background:var(--cc-on)}
.cc-meter .is-contexts{background:#8b7cd8}
.cc-meter .is-tools{background:#3f9c83}
.cc-key{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--cc-ink2)}
.cc-key-item{display:inline-flex;align-items:center;gap:5px}
.cc-dot{width:7px;height:7px;border-radius:99px;display:inline-block;flex:none}
.cc-dot.is-sections{background:var(--cc-on)}
.cc-dot.is-contexts{background:#8b7cd8}
.cc-dot.is-tools{background:#3f9c83}
.cc-dot.is-on{background:var(--cc-on)}
.cc-dot.is-brief{background:var(--cc-warn)}
.cc-dot.is-hidden{background:var(--cc-err)}

/* ---------- 标签页：把「能力 / 构成 / 会话」分开，避免一屏到底 ---------- */
.cc-tabs{display:flex;gap:18px;padding:0 26px;margin-top:2px}
.cc-subtabs{
  display:flex;gap:6px;padding:12px 26px 2px;overflow-x:auto;scrollbar-width:none;
  mask-image:linear-gradient(90deg,transparent 0,#000 8px,#000 calc(100% - 8px),transparent 100%);
}
.cc-subtabs::-webkit-scrollbar{display:none}
.cc-subtab{
  appearance:none;border:1px solid var(--cc-line);background:transparent;color:var(--cc-ink2);
  font:inherit;font-size:12.5px;padding:5px 11px;border-radius:999px;cursor:pointer;white-space:nowrap;
  display:inline-flex;align-items:center;gap:6px;transition:background .14s ease,border-color .14s ease,color .14s ease;
}
.cc-subtab:hover:not(:disabled){background:var(--cc-hover);color:var(--cc-ink)}
.cc-subtab.is-active{background:var(--cc-ink);border-color:var(--cc-ink);color:#fff}
.cc-subtab-badge{font-size:11px;opacity:.6;font-variant-numeric:tabular-nums}
.cc-subtab-note{font-size:11px;opacity:.5;font-variant-numeric:tabular-nums}
.cc-tab-note{font-size:11px;color:var(--cc-ink3);font-variant-numeric:tabular-nums;margin-left:2px}
.cc-hint.is-tight{margin:4px 0 8px}
.cc-auto{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0 10px;font-size:11.5px;color:var(--cc-ink3)}
.cc-auto-check{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.cc-auto-check input{margin:0;accent-color:var(--cc-ink)}
.cc-auto-num{
  width:56px;appearance:textfield;border:1px solid var(--cc-line);border-radius:6px;background:transparent;
  color:var(--cc-ink);font:inherit;font-size:11.5px;padding:2px 4px;text-align:right;font-variant-numeric:tabular-nums;
}
.cc-auto-num:disabled{opacity:.45}
.cc-subtab.is-active .cc-subtab-badge{opacity:.72}
.cc-tab{
  appearance:none;border:0;background:none;cursor:pointer;font:inherit;font-size:12.5px;
  color:var(--cc-ink2);padding:9px 0 8px;border-bottom:2px solid transparent;display:flex;align-items:center;gap:6px;
}
.cc-tab:hover{color:var(--cc-ink)}
.cc-tab[aria-selected="true"]{color:var(--cc-ink);border-bottom-color:var(--cc-ink);font-weight:600}
.cc-tab .cc-badge{
  font-size:10.5px;line-height:1;padding:2px 5px;border-radius:99px;
  background:var(--cc-soft);color:var(--cc-ink3);font-weight:500;
}
.cc-tab[aria-selected="true"] .cc-badge{background:var(--cc-hover);color:var(--cc-ink2)}

/* ---------- 内容区 ---------- */
.cc-view{padding:6px 26px 40px;max-width:1120px}
.cc-block{padding:18px 0 4px;border-bottom:1px solid var(--cc-soft)}
.cc-block:last-child{border-bottom:0}
.cc-block-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}
.cc-h2{margin:0;font-size:13px;font-weight:650;letter-spacing:-.005em}
.cc-h3{margin:0;font-size:12.5px;font-weight:600}
.cc-hint{margin:0;font-size:11.5px;color:var(--cc-ink3);flex:1 1 260px;min-width:0}
.cc-count{margin-left:auto;font-size:11.5px;color:var(--cc-ink3);white-space:nowrap}
.cc-count.is-static{margin-left:0}
.cc-block-head.is-toggle{appearance:none;border:0;background:none;font:inherit;text-align:left;width:100%;cursor:pointer;padding:0}
.cc-block-head.is-toggle:hover .cc-h2{color:var(--cc-on)}
.cc-tools{padding-top:8px}
.cc-tools-search{width:100%;max-width:320px;margin-bottom:6px}

/* 工具条 / 行内控件 */
.cc-btn{
  appearance:none;border:1px solid var(--cc-line);background:var(--cc-bg);color:var(--cc-ink);
  font:inherit;font-size:12px;line-height:1.2;padding:5px 10px;border-radius:7px;cursor:pointer;
  transition:background .14s ease,border-color .14s ease;
}
.cc-btn:hover:not(:disabled){background:var(--cc-hover)}
.cc-btn:disabled{opacity:.45;cursor:default}
.cc-btn.is-primary{background:var(--cc-ink);border-color:var(--cc-ink);color:#fff}
.cc-btn.is-primary:hover:not(:disabled){background:color-mix(in srgb,var(--cc-ink) 88%,#000)}
.cc-btn.is-ghost{border-color:transparent;background:transparent;color:var(--cc-ink2);padding:4px 8px}
.cc-btn.is-ghost:hover:not(:disabled){background:var(--cc-hover);color:var(--cc-ink)}
.cc-btn.is-danger{color:var(--cc-err)}
.cc-btn.is-mini{font-size:11px;padding:2px 7px;border-radius:99px;color:var(--cc-ink2)}
.cc-btn.is-mini.is-primary{color:#fff}
.cc-link{
  appearance:none;border:0;background:none;font:inherit;font-size:11px;color:var(--cc-ink3);
  cursor:pointer;padding:2px 4px;border-radius:5px;
}
.cc-link:hover:not(:disabled){color:var(--cc-ink);background:var(--cc-hover)}
.cc-link.is-muted{opacity:.5;cursor:default}
.cc-input,.cc-textarea{
  border:1px solid var(--cc-line);border-radius:7px;background:var(--dsw-alias-input-bg,var(--cc-bg));
  color:var(--cc-ink);font:inherit;font-size:12px;padding:5px 8px;
}
.cc-input::placeholder,.cc-textarea::placeholder{color:var(--cc-ink3)}
.cc-input:hover,.cc-textarea:hover{border-color:color-mix(in srgb,var(--cc-ink3) 45%,transparent)}
.cc-input:focus,.cc-textarea:focus{outline:none;border-color:color-mix(in srgb,var(--cc-on) 60%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--cc-on) 15%,transparent)}
.cc-textarea{width:100%;min-height:150px;resize:vertical;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.6}
.cc-textarea.is-small{min-height:66px;font-family:inherit;font-size:12px}
.cc-row-gap{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.cc-check{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;color:var(--cc-ink2);cursor:pointer}
.cc-check input{accent-color:var(--cc-on);width:13px;height:13px;margin:0}

/* ---------- 能力：项目条 + 状态账 + 分组 ---------- */
.cc-projline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
.cc-projline .cc-select{max-width:340px}
.cc-projmeta{margin-top:6px;font-size:11px;color:var(--cc-ink3);display:flex;gap:10px;flex-wrap:wrap}
.cc-projmeta code{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:10.5px;color:var(--cc-ink2)}
.cc-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px dashed var(--cc-soft)}
.cc-actions-label{font-size:11px;color:var(--cc-ink3);margin-right:2px}
.cc-tally{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;margin:12px 0 2px;font-size:11.5px;color:var(--cc-ink2)}
.cc-tally-item{display:inline-flex;align-items:center;gap:6px}
.cc-tally-item b{font-size:13px;font-weight:650;color:var(--cc-ink)}
.cc-pills{display:inline-flex;gap:5px}
.cc-pill{font-size:10.5px;line-height:1.5;padding:0 6px;border-radius:99px;background:var(--cc-soft);color:var(--cc-ink2)}
.cc-pill.is-brief{background:color-mix(in srgb,var(--cc-warn) 14%,transparent);color:var(--cc-warn)}
.cc-pill.is-hidden{background:color-mix(in srgb,var(--cc-err) 12%,transparent);color:var(--cc-err)}

.cc-capgroup{border-top:1px solid var(--cc-soft);padding:4px 0 2px}
.cc-capgroup>summary{
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer;list-style:none;
  padding:9px 0 7px;
}
.cc-capgroup>summary::-webkit-details-marker{display:none}
.cc-capgroup>summary::before{
  content:"";width:5px;height:5px;border-right:1.5px solid var(--cc-ink3);border-bottom:1.5px solid var(--cc-ink3);
  transform:rotate(-45deg);transition:transform .16s ease;flex:none;margin-right:2px;
}
.cc-capgroup[open]>summary::before{transform:rotate(45deg)}
.cc-capgroup>summary:hover .cc-h3{color:var(--cc-on)}
.cc-capgroup .cc-hint{padding:0 0 6px 17px;margin-top:-2px}
.cc-cap-list{padding:0 0 8px}
.cc-cap-actions{margin-left:auto;display:inline-flex;gap:4px}
.cc-cap-actions .cc-btn{font-weight:500}
.cc-capgroup>summary::marker{content:""}

.cc-cap{display:grid;grid-template-columns:minmax(0,1fr) 54px auto 34px;gap:12px;align-items:center;padding:6px 0 6px 17px;border-top:1px solid var(--cc-soft)}
.cc-cap:first-child{border-top:0}
.cc-cap:hover{background:color-mix(in srgb,var(--cc-ink) 3.5%,transparent);border-radius:6px;margin-left:-6px;padding-left:23px;padding-right:6px}
.cc-cap-main{min-width:0}
.cc-cap-title{display:flex;align-items:center;gap:6px;min-width:0}
.cc-cap-name{font-size:12px;color:var(--cc-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-cap-sum{font-size:11px;color:var(--cc-ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.cc-cap.is-brief .cc-cap-name{color:var(--cc-ink2)}
.cc-cap.is-hidden .cc-cap-name{color:var(--cc-ink3)}
.cc-num{text-align:right;font-size:11.5px;color:var(--cc-ink2);font-variant-numeric:tabular-nums}
.cc-cap.is-hidden .cc-num{color:var(--cc-ink3)}
.cc-num.is-wide{text-align:right;color:var(--cc-ink3);font-size:11.5px;white-space:nowrap}

/* 三档：一条轨道，选中项是实心的，没选的只有文字 */
.cc-seg{display:inline-flex;align-items:center;padding:2px;border-radius:99px;background:var(--cc-soft);flex:none}
.cc-seg.is-readonly{padding:3px 9px;font-size:10.5px;color:var(--cc-ink3);border:1px dashed color-mix(in srgb,var(--cc-ink3) 34%,transparent);background:transparent;white-space:nowrap}
.cc-cap.is-readonly .cc-cap-name{color:var(--cc-ink2)}
.cc-seg-btn{
  appearance:none;border:0;background:transparent;color:var(--cc-ink3);font:inherit;font-size:11px;line-height:1;
  padding:4px 8px;border-radius:99px;cursor:pointer;transition:background .14s ease,color .14s ease;
}
.cc-seg-btn:hover:not(:disabled):not(.is-active){color:var(--cc-ink);background:color-mix(in srgb,var(--cc-bg) 60%,transparent)}
.cc-seg-btn.is-active{background:var(--cc-bg);color:var(--cc-ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.10),inset 0 0 0 1px color-mix(in srgb,var(--cc-ink) 10%,transparent)}
.cc-seg-btn.is-active.is-on{color:var(--cc-on)}
.cc-seg-btn.is-active.is-brief{color:var(--cc-warn)}
.cc-seg-btn.is-active.is-hidden{color:var(--cc-err)}
.cc-seg-btn:disabled{opacity:.5;cursor:default}
.cc-tag{font-size:10.5px;line-height:1.6;padding:0 5px;border-radius:4px;background:var(--cc-soft);color:var(--cc-ink3);white-space:nowrap}
.cc-tag.is-off{color:var(--cc-warn);background:color-mix(in srgb,var(--cc-warn) 12%,transparent)}

/* ---------- 构成：模块行 ---------- */
.cc-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:0 0 10px;border-bottom:1px solid var(--cc-soft)}
.cc-toolbar.is-cap{flex-wrap:nowrap;gap:8px;padding:2px 0 9px}
.cc-toolbar.is-cap .cc-input{flex:1 1 auto;min-width:0}
.cc-toolbar.is-cap .cc-cap-actions{margin-left:0;flex:0 0 auto}
.cc-list{padding:2px 0}
.cc-row{display:grid;grid-template-columns:auto minmax(0,1fr) 58px auto;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--cc-soft)}
.cc-row:first-child{border-top:0}
.cc-row:hover{background:color-mix(in srgb,var(--cc-ink) 3%,transparent);border-radius:6px}
.cc-row-main{min-width:0}
.cc-row-title{display:flex;align-items:center;gap:6px;min-width:0}
.cc-name{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:11.5px;color:var(--cc-ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-row-preview{font-size:11px;color:var(--cc-ink3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.cc-row.is-off .cc-name{color:var(--cc-ink3);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--cc-ink3) 55%,transparent)}
.cc-row.is-off .cc-row-preview{opacity:.6}
.cc-row-actions{display:flex;gap:2px;justify-content:flex-end}
.cc-row-tool{padding:6px 0}
.cc-token{font-size:11.5px;color:var(--cc-ink2);text-align:right;font-variant-numeric:tabular-nums}
.cc-token.is-muted{color:var(--cc-ink3)}

/* 开关 */
.cc-switch{
  appearance:none;border:0;padding:0;width:30px;height:18px;border-radius:99px;background:var(--cc-soft);
  position:relative;cursor:pointer;transition:background .16s ease;flex:none;
}
.cc-switch:hover:not(:disabled){background:color-mix(in srgb,var(--cc-ink3) 32%,transparent)}
.cc-switch.is-on{background:var(--cc-on)}
.cc-switch.is-on:hover:not(:disabled){background:color-mix(in srgb,var(--cc-on) 86%,#000)}
.cc-switch:disabled{opacity:.45;cursor:default}
.cc-switch-dot{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:99px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .16s cubic-bezier(.2,.8,.2,1)}
.cc-switch.is-on .cc-switch-dot{transform:translateX(12px)}

.cc-bar{height:4px;border-radius:99px;background:var(--cc-soft);overflow:hidden}
.cc-bar-fill{display:block;height:100%;background:color-mix(in srgb,var(--cc-ink2) 55%,transparent);transition:width .2s ease}
.cc-bar-fill.is-warn{background:var(--cc-warn)}

/* 编辑器 */
.cc-editor{margin:8px 0;padding:11px 12px;border:1px solid var(--cc-line);border-radius:10px;background:var(--dsw-alias-input-bg,var(--cc-bg))}
.cc-editor-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:8px;font-size:12px}
.cc-editor-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:8px}

/* ---------- 会话 ---------- */
.cc-breakdown{display:block;padding-top:4px}
.cc-session{padding:10px 0 0}
.cc-breakdown-total{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:8px 0 10px}
.cc-breakdown-total b{font-size:17px;font-weight:650;letter-spacing:-.01em}
.cc-bucket{display:grid;grid-template-columns:minmax(92px,auto) 52px 62px minmax(0,1fr);gap:10px;align-items:center;padding:6px 0;border-top:1px solid var(--cc-soft)}
.cc-bucket:first-child{border-top:0}
.cc-bucket-label{font-size:12px;color:var(--cc-ink)}
.cc-bucket-count{font-size:11px;color:var(--cc-ink3)}
.cc-bucket-token{font-size:11.5px;color:var(--cc-ink2);text-align:right}
.cc-breakdown-note{margin-top:10px;padding-top:10px;border-top:1px dashed var(--cc-soft);font-size:11px;color:var(--cc-ink3)}

/* 简介预览 / 提示 */
.cc-brief{border-top:1px dashed var(--cc-soft);margin-top:8px;padding-top:8px}
.cc-brief>summary{cursor:pointer;font-size:11.5px;color:var(--cc-ink3)}
.cc-brief>summary:hover{color:var(--cc-ink2)}
.cc-brief-text{
  margin:7px 0 0;padding:10px 11px;border-radius:8px;white-space:pre-wrap;word-break:break-word;
  background:var(--cc-soft);color:var(--cc-ink2);font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);
  font-size:11px;line-height:1.6;max-height:220px;overflow:auto;
}
.cc-alert{margin:10px 0;padding:8px 11px;border-radius:8px;font-size:11.5px;color:var(--cc-err);background:color-mix(in srgb,var(--cc-err) 9%,transparent)}
.cc-alert.is-warn{color:var(--cc-warn);background:color-mix(in srgb,var(--cc-warn) 10%,transparent)}
.cc-alert.is-ok{color:#2f7d5c;background:color-mix(in srgb,#2f7d5c 10%,transparent)}
.cc-empty{padding:22px 0;color:var(--cc-ink3);font-size:12px;text-align:center}
.cc-empty.is-small{padding:8px 0;text-align:left}
.cc-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:16px 0 0;margin-top:6px;border-top:1px solid var(--cc-soft)}

/* ---------- 输入框左侧胶囊 ---------- */
.cc-chip{
  display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2,#e6e7eb);
  border-radius:99px;background:transparent;color:var(--dsw-alias-label-secondary,#5b616b);
  font:inherit;font-size:11.5px;line-height:1;padding:5px 9px;cursor:pointer;transition:background .14s ease,color .14s ease;
}
.cc-chip:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f6);color:var(--dsw-alias-label-primary,#1b1b1f)}
.cc-chip-icon{display:inline-flex;opacity:.75}

/* ---------- 注入弹窗 ---------- */
.cc-overlay{
  position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
  background:rgba(12,14,18,.44);backdrop-filter:blur(2px);padding:24px;
  animation:cc-fade .16s ease-out;
}
.cc-dialog{
  width:min(680px,100%);max-height:min(86vh,900px);display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1b1b1f);
  border:1px solid var(--dsw-alias-border-l2,#e6e7eb);border-radius:14px;
  box-shadow:0 24px 60px -24px rgba(0,0,0,.45);
  animation:cc-rise .2s cubic-bezier(.2,.8,.2,1);
}
.cc-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px 12px;border-bottom:1px solid var(--dsw-alias-separator,rgba(0,0,0,.06))}
.cc-card-title{margin:0;font-size:13.5px;font-weight:650;letter-spacing:-.01em;display:block}
.cc-dialog-body{padding:14px 18px;overflow-y:auto;display:flex;flex-direction:column;gap:14px}
.cc-dialog-note{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b9099);line-height:1.6}
.cc-dialog-total{font-size:11.5px;color:var(--dsw-alias-label-secondary,#5b616b)}
.cc-sum{display:flex;flex-wrap:wrap;gap:6px 14px;margin:8px 0 2px;padding:8px 10px;border:1px solid var(--cc-line);border-radius:8px;background:var(--cc-hover);font-size:11.5px;color:var(--cc-ink2)}
.cc-sum b{color:var(--cc-ink);font-weight:650;font-variant-numeric:tabular-nums}
.cc-sum-first{display:inline-flex;align-items:center;min-width:0}
.cc-info-wrap{position:relative;display:inline-flex;align-items:center;margin-right:4px}
.cc-info{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;padding:0;border:1px solid var(--cc-line);border-radius:50%;background:transparent;color:var(--cc-ink3);font:600 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;font-style:normal;cursor:help;flex:0 0 auto}
.cc-info:hover,.cc-info.is-open{color:var(--cc-ink);border-color:color-mix(in srgb,var(--cc-ink3) 55%,transparent);background:var(--cc-hover)}
.cc-info-tip{position:absolute;left:-4px;top:calc(100% + 7px);z-index:40;width:min(330px,calc(100vw - 56px));padding:8px 10px;border:1px solid var(--cc-line);border-radius:8px;background:var(--cc-bg);box-shadow:0 10px 28px rgba(0,0,0,.18);font-size:11px;font-weight:400;line-height:1.55;color:var(--cc-ink2);text-align:left;white-space:normal}
.cc-pick-groups{display:flex;flex-direction:column;gap:14px}
.cc-pick-group{display:flex;flex-direction:column;gap:6px}
.cc-pick-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.cc-pick-title{font-size:12px;font-weight:600}
.cc-pick-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9099)}
.cc-pick{display:flex;flex-direction:column}
.cc-pick-row{
  display:grid;grid-template-columns:auto minmax(0,1fr) auto 52px;gap:9px;align-items:center;
  padding:6px 0;border-top:1px solid var(--dsw-alias-separator,rgba(0,0,0,.06));cursor:pointer;font-size:12px;
}
.cc-pick-row:first-child{border-top:0}
.cc-pick-row input{accent-color:var(--dsw-alias-state-business-primary,#3b6ef0);width:13px;height:13px;margin:0}
.cc-pick-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-pick-token{text-align:right;font-size:11.5px;color:var(--dsw-alias-label-secondary,#5b616b);font-variant-numeric:tabular-nums}
.cc-pick-row.is-on .cc-pick-label{font-weight:600}
.cc-field{display:flex;flex-direction:column;gap:5px}
.cc-field-label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#5b616b)}
.cc-dialog-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 18px;border-top:1px solid var(--dsw-alias-separator,rgba(0,0,0,.06))}
@keyframes cc-fade{from{opacity:0}to{opacity:1}}
@keyframes cc-rise{from{opacity:0;transform:translateY(6px) scale(.995)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
  .cc-overlay,.cc-dialog{animation:none}
  .cc-meter span,.cc-switch,.cc-switch-dot,.cc-seg-btn,.cc-btn,.cc-bar-fill{transition:none}
}

.cc-subtabs.is-secondary{
  position:relative;margin-top:2px;padding:4px 26px 10px 56px;
  border-top:1px solid var(--cc-soft);
}
.cc-subtabs.is-secondary::before{
  content:"";position:absolute;left:28px;top:11px;bottom:16px;width:2px;border-radius:2px;
  background:linear-gradient(var(--cc-line),transparent);
}
.cc-subtabs.is-secondary .cc-subtab{
  font-size:11.5px;padding:3px 9px;border-color:transparent;background:transparent;color:var(--cc-ink3);
}
.cc-subtabs.is-secondary .cc-subtab.is-active{
  background:var(--cc-bg);color:var(--cc-ink);border-color:var(--cc-line);
  font-weight:600;box-shadow:0 1px 2px rgba(15,18,24,.06);
}
.cc-subtab-minus{color:var(--cc-err);font-size:11px;font-variant-numeric:tabular-nums}
.cc-stats{
  display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px;
  padding:9px 26px;border-bottom:1px solid var(--cc-soft);
  font-size:12px;color:var(--cc-ink2);
}
.cc-stats b{color:var(--cc-ink);font-weight:600;font-variant-numeric:tabular-nums}
.cc-stats .is-warn{color:var(--cc-warn)}
.cc-stats .is-err{color:var(--cc-err)}
.cc-search{display:flex;align-items:center;gap:10px;padding:10px 26px 6px}
.cc-search .cc-input{max-width:280px}
@media (max-width:760px){
  .cc-top{padding:12px 16px 0}
  .cc-tabs{padding:0 16px;overflow-x:auto}
  .cc-subtabs{padding:10px 16px 2px}
  .cc-view{padding:4px 16px 32px}
  .cc-meter{flex:1 1 100%;min-width:0}
  .cc-key{gap:10px}
  .cc-projline .cc-select{max-width:none;flex:1 1 200px}
  .cc-cap{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding-left:12px}
  .cc-cap:hover{margin-left:0;padding-left:12px;padding-right:0}
  .cc-cap .cc-cap-main{grid-column:1;grid-row:1}
  .cc-cap .cc-num{grid-column:2;grid-row:1}
  .cc-cap .cc-seg{grid-column:1;grid-row:2;justify-self:start}
  .cc-cap .cc-link{grid-column:2;grid-row:2;justify-self:end}
  .cc-bucket{grid-template-columns:minmax(84px,auto) 58px minmax(0,1fr);gap:8px}
  .cc-bucket-count{display:none}
  .cc-row{grid-template-columns:auto minmax(0,1fr) auto;row-gap:2px}
  .cc-row .cc-row-main{grid-column:2}
  .cc-row .cc-token{grid-column:2;grid-row:2;text-align:left}
  .cc-row .cc-row-actions{grid-column:3;grid-row:1 / span 2;flex-direction:column;align-items:flex-end}
  .cc-tally{gap:12px}
  .cc-actions .cc-check{margin-left:0 !important}
}

/* ---------- 会话胶囊：点开才浮出来的那一层 ---------- */
.cc-chip.is-open{background:var(--dsw-alias-interactive-bg-hover,#f2f3f6);color:var(--dsw-alias-label-primary,#1b1b1f)}
.cc-chip-caret{opacity:.5;font-size:9px;margin-left:1px}
.cc-pop-layer{position:fixed;inset:0;z-index:70}
.cc-page.cc-pop{
  position:fixed;height:auto;min-height:0;overflow:hidden;display:flex;flex-direction:column;
  border:1px solid var(--cc-line);border-radius:12px;
  box-shadow:0 18px 44px rgba(10,12,18,.18),0 2px 8px rgba(10,12,18,.08);
  animation:cc-rise .14s ease-out;
}
.cc-pop-head{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px 8px;border-bottom:1px solid var(--cc-soft)}
.cc-pop-title{display:flex;align-items:baseline;gap:7px;min-width:0}
.cc-pop-title b{font-size:14px;font-weight:650;letter-spacing:-.01em}
.cc-ptabs{display:flex;flex:0 0 auto;height:38px;min-height:38px;box-sizing:border-box;flex-wrap:nowrap;gap:1px 2px;padding:0 10px;border-bottom:1px solid var(--cc-soft);overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
.cc-ptabs .cc-ptab{flex:0 0 auto}
.cc-ptabs::-webkit-scrollbar{height:4px}
.cc-ptabs::-webkit-scrollbar-track{background:transparent}
.cc-ptabs::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--cc-ink3) 35%,transparent);border-radius:999px}
.cc-ptab{
  appearance:none;border:0;background:transparent;color:var(--cc-ink2);font:inherit;font-size:12px;font-weight:600;
  padding:7px 8px 8px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;
  display:inline-flex;align-items:center;gap:5px;
}
.cc-ptab:hover{color:var(--cc-ink)}
.cc-ptab[aria-selected="true"]{color:var(--cc-ink);border-bottom-color:var(--cc-on)}
.cc-ptab .cc-badge{font-size:10px;padding:0 5px;line-height:15px}
.cc-pop-body{flex:1 1 0;min-height:0;overflow-y:auto;padding:9px 12px 10px;scrollbar-width:thin}
.cc-pop-body.is-usage{padding-top:4px}
.cc-pop-body.is-usage .cc-sum{margin-top:2px}
.cc-pop-foot{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:10px;flex-wrap:nowrap;padding:8px 12px;border-top:1px solid var(--cc-soft);background:color-mix(in srgb,var(--cc-soft) 40%,transparent)}
.cc-pop-foot>.cc-muted{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-pop-foot .cc-row-gap{flex:0 0 auto;flex-wrap:nowrap}
.cc-pop-foot .cc-btn{white-space:nowrap}
.cc-pop-toolbar{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:6px 12px;border-bottom:1px solid var(--cc-soft);background:color-mix(in srgb,var(--cc-bg) 96%,transparent)}
.cc-pop-search{position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:0}
.cc-pop-toolbar .cc-cap-actions{margin-left:0;flex:0 0 auto}
.cc-pop-search .cc-input{width:100%;padding-right:26px}
.cc-pop-search .cc-input::-webkit-search-cancel-button{-webkit-appearance:none;display:none}
.cc-pop-search-clear{position:absolute;right:4px;top:50%;width:20px;height:20px;transform:translateY(-50%);border:0;border-radius:50%;background:transparent;color:var(--cc-ink3);font-size:15px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}
.cc-pop-search-clear:hover{background:var(--cc-hover);color:var(--cc-ink)}
.cc-pop-page-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;height:30px;min-height:30px;max-height:30px;padding:0 12px;border-bottom:1px solid var(--cc-soft);background:color-mix(in srgb,var(--cc-bg) 96%,transparent)}
.cc-pop-page-title{flex:0 0 46px;width:46px;font-size:12px;font-weight:650;color:var(--cc-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cc-pop-page-meta{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cc-ink3);font-size:11px}
.cc-pop-page-actions{flex:0 0 auto;display:flex;align-items:center;gap:4px}
.cc-pop-caps-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:1px 0 5px;min-height:18px;flex-wrap:nowrap}
.cc-pop-note{margin-top:9px;padding-top:8px;border-top:1px dashed var(--cc-soft);color:var(--cc-ink3);font-size:10.5px;line-height:1.55}
.cc-cap.is-compact{grid-template-columns:minmax(0,1fr) 44px auto 20px;gap:8px;padding:5px 0}
.cc-cap.is-compact .cc-cap-sum{display:none}
.cc-link.is-icon{width:20px;justify-content:center;padding:0;text-align:center;font-size:12px}
.cc-alert.is-ok{margin:0 0 8px}
@keyframes cc-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

/* AI 建议：默认折叠成一条，点击才请求；不是聊天框。 */
.cc-ai{
  display:flex;flex-direction:column;gap:8px;margin:10px 26px 4px;padding:10px 12px;
  border:1px solid var(--cc-line);border-radius:8px;background:color-mix(in srgb,var(--cc-bg) 97%,var(--cc-soft));
}
.cc-ai-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cc-ai-note{font-size:11px;line-height:1.5;color:var(--cc-ink2)}
.cc-ai-card{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--cc-soft)}
.cc-ai-summary{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:11.5px;font-weight:600;color:var(--cc-ink)}
.cc-ai-meta{font-size:10.5px;font-weight:400;color:var(--cc-ink2);white-space:nowrap}
.cc-ai-warn{font-size:11px;color:var(--cc-warn-text,#7a5a00)}
.cc-ai-row{display:grid;grid-template-columns:14px minmax(0,1.4fr) auto minmax(0,2fr) auto;gap:8px;align-items:center;padding:4px 0;border-top:1px solid var(--cc-soft);font-size:11.5px}
.cc-ai-row input{width:13px;height:13px;margin:0}
.cc-ai-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cc-ink)}
.cc-ai-action{font-size:10.5px;font-weight:600;padding:1px 6px;border-radius:99px;border:1px solid var(--cc-line);white-space:nowrap}
.cc-ai-action.is-hide{color:var(--cc-err);border-color:color-mix(in srgb,var(--cc-err) 35%,transparent)}
.cc-ai-action.is-brief{color:#7a5a00;border-color:#d9c58a}
.cc-ai-action.is-rewrite{color:var(--cc-on-text,#2f5fd4);border-color:#b9c8f5}
.cc-ai-why{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cc-ink2);font-size:11px}
.cc-ai-save{font-size:11px;color:var(--cc-ink2);font-variant-numeric:tabular-nums;white-space:nowrap}
.cc-ai-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:2px}

.cc-ai-inline{margin:0 26px 8px;padding:8px 10px;border:1px solid #d9e2fb;border-radius:8px;background:#f7f9ff}
.cc-ai-inline-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px}
.cc-ai-inline-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:11px}
.cc-ai-inline-row .cc-ai-why{flex:1 1 auto;min-width:120px}
@media (max-width:760px){.cc-ai{margin:10px 16px 4px}.cc-ai-row{grid-template-columns:14px minmax(0,1fr) auto;}.cc-ai-why{grid-column:2/-1}}
@media (prefers-reduced-motion:reduce){.cc-page.cc-pop{animation:none}}

`;

    /* ------------------------------------------------------------------ 注册 */

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.dshPlugin = "context-control";
        style.textContent = CSS;
        document.head.append(style);
        return () => style.remove();
      }, "context-control:css");

      // 左栏入口 + 主面板（key 与 sidebar id 必须一致，左栏按钮才会打开这个面板）
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "context-control" }, Panel));
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          { name: "sidebar.panellist", id: "context-control", order: 25, label: () => "上下文管控" },
          Icon,
        ),
      );

      // 会话内入口：输入框左侧的小胶囊
      ctx.slots.inject("conversation.input.left", () =>
        ctx.slots.register({ name: "conversation.input.left", id: "context-control", order: 20 }, (props) =>
          props && props.sessionId
            ? h(ComposerChip, {
                key: props.sessionId,
                sessionId: props.sessionId,
                inputActions: props.inputActions ?? null,
              })
            : null,
        ),
      );

      // 浮层：胶囊点开后浮在输入框上方的那一层（勾模块 / 管能力）
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "context-control-inject" }, ChipPopover),
      );
    }

    exports.name = "dsh-context-control";
    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
