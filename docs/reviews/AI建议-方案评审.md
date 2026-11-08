# AI 建议方案评审（t2 架构 + t3 UX）

- 评审对象：`docs/AI建议-架构方案.md`、`docs/AI建议-UI设计.md`、`docs/mockups/ai-ui.html`、`docs/images/ai-*.png`，以及 `client.js` / `lib/*.js` 的 0.5.30 实现。
- 结论：**needs_revision**。方向成立，但当前稿不能直接进入实现；P0 涉及写入原语、事务、undo、模型路由、llm 流式契约和保护名单，不是文字问题。
- 本文件是 t4 的输入；t4 只改文档，不改 `client.js` / `lib/*.js`。

## 一、P0：架构必须先修

1. **作用域 × 类型矩阵与现有写入原语不一致**
   - 方案允许 parts/session 做文本改写、global/project 做提示段/工具，并映射到 `setRule/setScopeRule/setSessionRule`。
   - `lib/store.js:509` 的 `setScopeRule` 只接受 sections/tools，contexts 直接 throw；`:662` 的 `setSessionRule` 同样；`:480-505` 的 layers 从不下沉 contexts；只有 `:801-822` 的 `setRule` 支持 contexts，且写当前 active mode。
   - 需新增 `TYPE_SCOPE_MATRIX`（cap/section/context/tool × global/project/parts/session/item），不支持的组合在 schema 层拒绝并 warning；若要 context 跨层，必须扩展 store 的 global/project/session.contexts、layers 合并和三个 `set*`。

2. **all-or-nothing 没有事务**
   - 方案承诺全有或全无，但 store 每个 set* 独立 `writeFileAtomic`（`:516/524`、`:623`、`:673/684`、`:796`、`:820`），state 只有 version:3，没有 revision 或事务 API。
   - 20 项 apply 会写 20 次盘，中途异常会留下半份配置；并发 apply 会互相覆盖。
   - 需新增 `store.transaction(fn)` / `applyOps(ops)`：先全量校验，再内存快照 + 单次 `writeFileAtomic`，失败回滚；apply 入口加进程内 mutex。

3. **undo 未绑定 parts 的 active mode**
   - 方案只记录 previous；`setRule` 在 `store.js:805` 用 `this.active()`，没有 modeId。
   - apply 后切换模式再 undo 会写进新模式，跨模式还可能覆盖别的规则。
   - `undoToken` 需记录 modeId + scopeKey + 每 key previous；undo 前校验 active mode；`setRule` 增加 modeId 或 `setRuleForMode`；冲突返回 conflict，不硬写。

4. **模型路由取错层，且“最近成功路由”会串会话**
   - 方案用 `session.requestHeader()?.config`；`dsh-session` 的 requestHeader 只折叠最后一个 request/header，首次请求前 undefined，漏掉 pending selection；`agent.options` 只是 `agent.model.current()` 内部一环；方案没读 `ctx.agentDefaultModel.currentSelection()`。
   - 跨会话缓存“最近成功路由”会让 A 会话模型被 B 会话复用。
   - 建议顺序：`agent.model.current()` → `ctx.agentDefaultModel.currentSelection()` → unavailable；`state.ai` 增加 `routeSource`；不要跨会话缓存。

5. **llm.stream 请求/响应契约不符**
   - 方案用 `messages:[{role:"system",content:systemPrompt}]` 字符串 content；`dsh-llm` 要求 content blocks（`[{type:"text",text}]`）。
   - adapter selection/dispatch/iteration 失败不会 throw，而是终端 `{type:"finish", kind:"error"|"aborted", failure}`；只拼 text-delta 会得到空文本并误判成功。
   - `maxTokens` 固定 4096、temperature 0.2、解析失败重试一次，未用 `resolveModelInfo(provider,model,signal)` 的 defaultMaxTokens/contextWindow；插件内重试会与 dsh-llm-retry 叠加。
   - 需用 `createSystemMessage` 或 content blocks、BlockAssembler、检查 finish.kind/failure.code、由 resolveModelInfo 夹取 maxTokens、仅对 retryable 重试、把 60s AbortSignal 传到 stream。

6. **硬护栏没有可执行数据，且 run_code 不可被本插件限制**
   - “不可关项/未知 id/隐藏能力全部 sections+tools”没有服务端常量或 inventory 字段；`capabilities.js` 的 buildCatalog/applyCaps 没有 blocked/protected 概念。
   - 本插件自身工具不在 catalog：`TOOL_PREFIX_ALIASES/TOOL_NAME_HINTS`（`capabilities.js:51-76`）没有 `context_control_*`，`RESERVED_PREFIXES`（`:15-24`）又把 `context:` 段排除。
   - `dsh-tools` 明确 restrict 不能命名 PTC 传输工具 `run_code`（types__index.js:107）；PTC 子调用继承 allow/deny，但“禁止 run_code 本身”必须在宿主/执行器层处理。
   - 建议：`lib/ai/schema.js` 定义 PROTECTED 常量（read/write/edit/bash/terminal_*/run_code/context_control_*/compress/decompress/ask_user_question 等），suggest/apply 两侧都校验；写明 run_code 宿主级例外；为每个护栏写拒绝测试。

## 二、P1：高优先级

- **hide 语义不成立**：`lib/index.js:503-517` 的 scopeBriefItems 与 `:533-568` 的 modeBriefItems 会把所有 `enabled:false` 项自动写进简介，只有 cap hidden 在 `capabilities.js:318-336` 被排除。需给规则加 `hidden:true` 并在 brief 生成时排除，或把 hide 限定 cap-only。
- **parts 的 cap/skill 无写入路径**：`setRule` 只接受 section/tool/context；cap key 不是 RULE_KINDS；skills 由 `filterSkillSections` 消费 plan.skills（`index.js:735`）。需给 parts 增加 cap 存储，或明确 parts 只能建议 section/context/tool。
- **fingerprint 覆盖不足**：只 hash rules+caps+total；需 hash 规范化 inventory（section 文本 hash/tool 名/cap key）+ rules + caps + store revision；totals 只用于展示。
- **aiCache/aiBusy scopeKey 不完整**：global/parts 的 scopeKey 跨会话共享，fingerprint 又含会话 prompt.total；aiBusy 只按 sessionId。需 `scope/projectId/sessionId/modeId` 拼 key，每个 key 一把锁。
- **“隐藏能力=其 sections/tools 全隐藏”是启发式**：`capabilities.js:98-107` 只按首个冒号前缀且排除 RESERVED，`pluginOfTool` 靠硬编码（`:51-76/116-125`），capPlan 只展开已识别项。需返回 unresolved 并 warning，不承诺“全部隐藏”。
- **其他插件的 restrict 不可见**：`liveToolNames` 不传 scope（`index.js:146-154`），只看到全局；`syncAgentRestriction` 只挂自身 deny（`:163-210`）。需 `schemas(agent)` 与全局差集，暴露 `foreignRestricted`。
- **证据快照跨会话串台**：`capabilityCatalog` 用 `snapshots.get(agentId) ?? snapshots.latest()`（`:294`），`buildState` 又把 sessionId 当 agentId（`:768`）。AI 证据只接受该 session 的 snapshot；没有则 `available:false`，不要 fallback latest。
- **apply 后只清 aiCache 不够**：还需清 catalogCache/effectiveByAgent/capDiag/agentRestrictions（`:214-221`、`:288-305`），统一走 `runAction` 或显式 invalidate + reset。
- **本地 API 无认证 + AI 成本**：`handleApi`（`:1309-1345`）无 Origin/Sec-Fetch-Site/CSRF；任意本地页面可触发 aiSuggest 消耗模型配额或改配置。需校验 Origin/CSRF，aiSuggest 限流，aiApply 只接受服务端缓存 id。
- **数据外发/隐私未定义**：完整 systemPrompt/contexts 发给 provider，但没有 opt-in、开关、provider/model 展示、脱敏。建议 AI 功能默认关闭，首次启用告知发送内容，state 展示 provider/model/估算输入 token，做 secret 扫描/截断。
- **session cap 50 条剪枝**：`store.js:131` 的 `MAX_SESSION_CAPS=50`，`setSessionCap` 每次 prune（`:653`）；AI 批量写可能挤掉旧会话，undo 失败。需限制 AI 条数并记录被 prune 的会话。
- **测试缺失**：当前没有 `test/` 与 scripts；`§11` 需补 node --test + mock llm，覆盖 P0-1..6、mode 切换 undo、中途失败回滚、foreign restrict、跨会话 snapshot、finish error/空文本、CSRF、orphan。

## 三、可选“其他插件/工具影响”数据契约

现有数据只够做 **advisory（低置信）**，不是因果级影响分析：

- catalog 有段名/工具名/前缀聚合，但没有插件版本、包名、enabled、依赖边，也没有 section↔tool 精确来源。
- `systemPrompt.section()` 只按 name 注册，没有 owner/source。
- 工具层只投影 name/description/parameters，没有 owner/package；MCP 可靠 `mcp__server__` 解析，其他靠前缀/hints。
- 规则依赖没有依赖图；只能查“规则 key 是否还在 catalog/实时工具名”，属于 orphan 检测。
- `pluginInventory` 是 Remote-only，只有 id/module/enabled/phase，没有贡献映射。

最小契约：

```ts
impact = {
  available: boolean, reason?: string, at: number,
  source: { snapshot: "session" | null, tools: "scoped" | "global" | null, loader: boolean },
  plugins?: [{ id, enabled, phase }],
  related: [{ key, kind, name, confidence: "low", sections: [], tools: [], basis: "prefix" | "hint" | "mcp" | "rule" }],
  unattributed: { sections: [{ name, tokens, why: "reserved" | "unknown" }], tools: [{ name, why: "unknown" | "mcp" }] },
  foreign: { restrictedTools: [name], restrictedSections: [name] },
  orphans: [{ scope, kind, key, why: "target-missing" }],
  unexplainedTokens: number,
  digest: "sha256:..."
}
```

- 只取该 session 的 snapshot；没有就 `available:false`。
- `related` 固定 low confidence，只在 UI 显示“可能相关（推测）”。
- `schemas()` 与 `schemas(agent)` 差集减自身 deny → foreign。
- 遍历 global/projects/modes/sessions 规则，key 不在 catalog/实时工具名 → orphans。
- impact digest 用于展示/缓存，不参与 apply 的阻塞 fingerprint。
- 默认关闭；开启才发第二次模型调用；切换只标 stale，不自动重跑；阻断项默认不勾选、不进批量。

## 四、UX P0（t3）

1. 会话 sheet 数字矛盾：总占用 12.7k，行内 mcp:github 14.4k；3 项 26.3k 却写少发 4.2k。
2. “隐藏”省量错误：4.2k→−3.8k、8.9k→−8.4k；隐藏应归零或说明保留摘要。
3. “应用选中”在 strip 与 AiCard 重复，只留一处。
4. 行内 pill 详情层无布局/定位/关闭/键盘规格，§11 无映射；新增 `AiPopover`。
5. 示意图只覆盖全局页+胶囊；项目页、构成页、行内 AI 无图。
6. 文档 0 处“其他插件/工具影响”开关；需补 `AiImpactToggle`、状态、验收、映射。

## 五、UX 高优先（摘要）

- 入口动词统一为 `AI 建议 · <层>`，保留“最低可用”副标题。
- AI strip 默认收起为工具栏 ghost，点击展开；断点统一 760；strip 37px、控件 22px；页头 AI 按钮 24×24 + aria-label。
- keep 项不出 pill；未生效建议用虚线/半透明 + “建议”；pill 列 auto/min-width 72px。
- 低置信+高风险组合 `可考虑隐藏·需确认`，默认不勾选、不进批量；结果卡显示中文“中风险·低置信”，不显示 medium/low。
- 结果卡滚动区 `tabindex=0 role=region`；diff 用真实缩短示例，补“已应用·还原”和焦点归位。
- sheet 与页签关系只留一个“返回”；body overflow/min-height:0、页脚固定；430px 触摸目标 apply 28px、pill 整行命中、AI 按钮≥24。
- Esc 层级：详情 > diff > 确认 > sheet > 浮层；焦点/live region/aria 规格补齐。
- AI 区文字禁用 `--cc-ink3`；状态表补 item running/error、partial、部分失败、撤销过期、busy、stale、筛选 0 条。
- 撤销栈建议内存、刷新失效，title 说明“本次会话内可撤销”。

## 六、建议修订顺序

1. `TYPE_SCOPE_MATRIX` + 事务 API + undoToken(modeId/revision) + PROTECTED 常量。
2. 模型路由与 llm.stream 契约。
3. fingerprint、scopeKey、snapshot、apply 后缓存失效。
4. 可选 impact（§13，advisory、默认关闭、不自动应用）。
5. 再对齐 UI（t3 的 P0 + 高优先项）。

P0-1..6 修完前不建议进入实现；否则会出现“能建议、不能应用/应用一半/撤销错模式”的组合。

## 七、t5 终验补丁（captain 已处理）

- **T5-F1 blocker**：`PROTECTED` 增加 cap 展开（`capPlan` 后逐项校验）、`plugin:dsh-ops` / `plugin:billion-context` / `plugin:terminal` / `plugin:context-control`、`ops_*` 前缀与 `acp_read_original_image` / `acp_cache`；§8.3 校验顺序同步；测试 31。
- **T5-F2 high**：§6.1 第 7–9 条明确 `sanitizeState` 显式保留 `ai`/`revision`，建议 `version:4` 兼容读 v3，补 round-trip 测试 32。
- **T5-F3 low**：§4.1 增加 `inject` 对象式可选注入 `agentDefaultModel`，缺失时 `routeSource:"none"`，测试 33。
- 仍余：项目页/构成页/行内 AI 视觉稿与截图待补；实现阶段再补。
