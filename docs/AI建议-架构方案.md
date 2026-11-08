# AI 建议 · 架构与实现方案（规划）

- 基线：`0.5.30`（HEAD `3c7e7b8`）。
- 状态：设计稿 v3，已按 [AI建议-方案评审.md](./reviews/AI建议-方案评审.md)（t2 架构 + t3 UX）与 t5 终验（cap 展开、持久化、可选注入）修订；未实现运行时代码。
- 关联：[AI建议-UI设计.md](./AI建议-UI设计.md)、[UI设计.md](./UI设计.md)、[需求与技术方案.md](./需求与技术方案.md)。
- 前置结论：上一版「3 个分析 agent + 一次性 `docs/analysis/*` 报告」方案作废；现在按页面点击、按作用域、单次调用。

## 0. 评审 P0 对照

| 评审项 | 本版落点 | 处理 |
| --- | --- | --- |
| P0-1 作用域 × 类型矩阵 | §2.2 `TYPE_SCOPE_MATRIX`、§2.3 context 限制 | 已对齐 0.5.30 原语 |
| P0-2 all-or-nothing 无事务 | §6.1 `store.transaction` / `applyOps` | 全量校验 + 单次落盘 + 回滚 |
| P0-3 undo 未绑定 mode | §6.3 `undoToken(modeId, revision, scopeKey)` | 切模式/改配置拒绝 |
| P0-4 模型路由取错层 | §4.1 `agent.model.current()` → `ctx.agentDefaultModel.currentSelection()` | 不跨会话缓存 |
| P0-5 `llm.stream` 契约 | §4.2 content blocks / finish / resolveModelInfo / AbortSignal | 不在插件内重复 retry |
| P0-6 护栏无数据 + run_code | §8 `PROTECTED` 常量、§8.2 宿主级例外 | suggest/apply 双校验 |
| P0-7 cap 整包绕过 PROTECTED（t5-F1） | §8.1 cap 先 capPlan 展开；§8.3 校验顺序 | 拒绝 dsh-ops/billion-context/terminal；补 ops_*/acp_* |
| P0-8 sanitize 丢 ai/revision（t5-F2） | §6.1 第 7–9 条、§10.1 | 显式白名单 + v4 + round-trip 测试 |
| P1 hide/brief、fingerprint、scopeKey 等 | §7、§9、§11、§12 | 逐项落地 |
| 可选影响分析 | §10 `impactScan` | advisory、默认关闭 |

## 1. 目标与非目标

### 目标

1. 在全局、项目、构成、会话四个入口，按当前作用域给出**可执行建议**：保留、简介、隐藏、改写。
2. 每条建议带证据：`reason`、`confidence`、`risk`、`currentTokens`、`savedTokens`。
3. 建议先预览、再应用；默认不写配置；应用后可撤销。
4. 不预取、不同时分析多个作用域；一个会话同时只跑一个 AI 任务。
5. 模型调用复用宿主 agent 的 provider/model，不新建模型供应商。
6. 可选分析「其他插件/工具对本插件的影响」，只做 advisory，默认关闭（§10）。

### 非目标

- 不自动批量分析所有页面；
- 不自动应用建议，不因影响分析自动勾选或改档；
- 不新增模型供应商、API key 或独立计费；
- 不改工具描述文本，只允许系统提示段/运行时注入的文本改写；
- 不把 AI 输出当结论；不把 0 次调用直接等同「可以删」；
- 不修改 DSH 宿主代码（`run_code` 的硬限制见 §8.2）。

## 2. 作用域与写入原语

### 2.1 0.5.30 的真实能力

| 层 | 能力档 | 系统提示段 | 运行时上下文 | 工具 | 现有原语 | 事实 |
| --- | --- | --- | --- | --- | --- | --- |
| 全局 | ✓ | ✓ | ✗ | ✓ | `setCap("global")`、`setScopeRule("global", kind, key, patch)` | `global` 只有 `caps/sections/tools` |
| 项目 | ✓ | ✓ | ✗ | ✓ | `setCap(projectId)`、`setScopeRule(projectId, ...)` | 项目结构同样没有 `contexts` |
| 构成（模式） | ✗ | ✓ | ✓ | ✓ | `setRule(kind, key, patch)` | 写 `this.active()`，**没有 modeId 参数** |
| 会话 | ✓ | ✓ | ✗ | ✓ | `setSessionCap`、`setSessionRule(sessionId, kind, ...)` | `setSessionRule` 只接受 sections/tools |
| 单项 | 跟随父层 | 跟随父层 | 跟随父层 | 跟随父层 | 解析到父层后走对应原语 | 跨层写入拒绝 |

代码依据（0.5.30）：

- `lib/store.js:23` `RULE_KINDS = ["sections", "contexts", "tools"]`；
- `lib/store.js:508` `setScopeRule` 与 `:659` `setSessionRule` 对 `contexts` 直接抛错；
- `lib/store.js:480-505` `layersFor` / `layersForSession` 只合并 `sections/tools`；
- `lib/store.js:801-822` `setRule` 支持 `contexts`，但固定写当前 active mode；
- `lib/store.js:302` `writeFileAtomic`，每个 `set*` 各自 `save()`，没有 revision 或事务。

### 2.2 `TYPE_SCOPE_MATRIX`

`type` 取 `cap | section | context | tool`；`scope` 取 `global | project | parts | session | item`。

| type | global | project | parts（模式） | session | item |
| --- | --- | --- | --- | --- | --- |
| `cap` | `setCap("global")` | `setCap(projectId)` | ✗ 不支持 | `setSessionCap(sessionId)` | 解析到父层 |
| `section` | `setScopeRule("global", "sections")` | `setScopeRule(projectId, "sections")` | `setRuleForMode(modeId, "sections")` | `setSessionRule(sessionId, "sections")` | 解析到父层 |
| `context` | ✗ | ✗ | `setRuleForMode(modeId, "contexts")` | ✗ | 仅 parts |
| `tool` | `setScopeRule("global", "tools")` | `setScopeRule(projectId, "tools")` | `setRuleForMode(modeId, "tools")` | `setSessionRule(sessionId, "tools")` | 解析到父层 |

补充规则：

- store 新增 `setRuleForMode(modeId, kind, key, patch)`；现有 `setRule(kind, key, patch)` 改为 `return this.setRuleForMode(this.active(), kind, key, patch)`，保持旧调用兼容。`parts` 的所有写入必须走前者，并显式校验 `modeId === store.activeModeId`，禁止 UI 传一个「看起来像 modeId」的值冒充当前模式。
- **技能（skill）不是独立 type**：它以 cap key `skill:<name>` 存在，只有 `global/project/session` 能设档（`on/brief/hidden`）；`parts` 没有 cap 存储，不能建议「隐藏某个技能」。
- `parts` 的技能行属于承载它的目录段；只能对**整个段**做 section 操作，不能按技能行改写。UI 在构成页不提供技能开关的 AI 建议，避免「建议了但写不进去」。
- `parts` 的 cap/skill 限制在 §7.2 展开；0.6.0 不扩展模式 cap 存储。

### 2.3 `context` 跨层：0.6.0 明确限制

0.6.0 **只允许 `context` 在 parts（模式）层写入**；`global/project/session` 的上下文建议不生成、不展示、apply 直接拒绝。理由：

1. 三个层的数据结构里根本没有 `contexts` 桶，`sanitizeState` 往返会丢字段；
2. `layersFor/layersForSession` 不合并 contexts，即使硬写也不会生效；
3. 只改一个 `set*` 会造出「写进去但运行时读不到」的假生效，比不支持更糟。

将来若要放开，必须一次做全四件事，缺一不可：

1. `sanitizeState` 为 `global/projects/sessions` 增加 `contexts` 并做白名单；
2. `layersFor` / `layersForSession` 合并 contexts（会话层最强）；
3. `setScopeRule` / `setSessionRule` 接受 `contexts`；
4. 数据版本升到 v4 并做迁移；同时补「跨层 context 覆盖」测试。

拒绝码：`unsupported-scope`，`warnings` 里写「该作用域暂不支持运行时上下文改写」。

### 2.4 目标解析与校验

所有写入先过 `resolveWriteTarget(scope, item, ctx)`：

```ts
type WriteTarget =
  | { layer: "global"; primitive: "setCap" | "setScopeRule"; kind?: RuleKind }
  | { layer: "project"; projectId: string; primitive: "setCap" | "setScopeRule"; kind?: RuleKind }
  | { layer: "parts"; modeId: string; primitive: "setRuleForMode"; kind: RuleKind }
  | { layer: "session"; sessionId: string; primitive: "setSessionCap" | "setSessionRule"; kind?: RuleKind };
```

- `scope=item` 先解析到当前页面的层，再查矩阵；不按「值来自哪一层」反推。
- 继承来的行写到当前层时是**新增覆盖**，UI 要标「将在本层覆盖继承值」。
- `parts` 必须带 `modeId`；`session` 必须带 `sessionId`；`project` 必须带 `projectId`。
- 建议阶段与 apply 阶段各校验一次；任何一次失败都不写配置。

## 3. API

内部 API 仍走 `POST /dsh-context-control/api`（本地回环，安全要求见 §3.5）。

### 3.1 `aiSuggest`

```json
{
  "action": "aiSuggest",
  "scope": "global",
  "sessionId": "session-...",
  "projectId": "default-workspace",
  "kind": "cap",
  "name": "mcp:github",
  "focus": "本次只想做发布",
  "impactScan": false
}
```

- `scope=item` 时 `kind/name` 必填；`scope=global|parts` 不需要 `projectId`；
- `sessionId` 用于取该会话的模型路由、snapshot 与证据上下文；
- `focus` 可选，只用于 session/parts 的提示词，不读用户消息；
- `impactScan` 可选布尔；省略时取 `store.ai.impactScan === "on"`，显式 `true/false` 优先（§10）。

返回：

```json
{
  "ok": true,
  "suggestion": {
    "id": "ai_01...",
    "at": 1760000000000,
    "scope": "global",
    "scopeKey": "global|-|-|context-control",
    "modeId": "context-control",
    "revision": 42,
    "fingerprint": "sha256:...",
    "summary": "最低可用：保留 18 · 简介 9 · 隐藏 22",
    "minimal": { "keep": 18, "brief": 9, "hide": 22, "estimatedTokens": 10700, "savedTokens": 20500 },
    "items": [],
    "partial": false,
    "warnings": [],
    "impactScan": false,
    "impact": null
  }
}
```

- `revision` 是生成建议时的 `store.revision`，用于 apply/undo 冲突判断；
- `scopeKey` 定义见 §9；
- `impact` 见 §10.3，未开启时为 `null`。

### 3.2 `aiApply`

```json
{ "action": "aiApply", "suggestionId": "ai_01...", "itemIds": ["tool:browser"], "confirm": true }
```

- 只接受服务端缓存的 suggestion；`confirm` 必须为 `true`；
- 校验：scope、指纹、`revision`、modeId、item 存在、矩阵、PROTECTED；
- 默认全有或全无（§6.1）；`blocked` 项（§10）不进批量：
  - `itemIds.length > 1` 且含 `impact.kind="block"` → `422 blocked-in-batch`；
  - 单项应用必须带 `confirmBlocked: true`，否则 `422 blocked-needs-confirm`；
- 会话层写入若会触发 50 条剪枝（§12），默认拒绝，需 `allowSessionPrune: true`；
- 返回 `{ ok, applied, skipped, undoToken, prunedSessions }`。

### 3.3 `aiUndo`

```json
{ "action": "aiUndo", "undoToken": "undo_..." }
```

- 恢复应用前的规则/文本；内存保存，最多 20 条，1 小时；
- token 绑定 `sessionId + scopeKey + modeId + revision`（§6.3）；
- 当前 active mode 与 token.modeId 不一致 → `409 mode-switched`，不写；
- 当前 revision 与 token.revision 不一致 → `409 conflict`，返回冲突 key 列表，不硬写；
- 会话剪枝导致旧值不可恢复时返回 `undoPartial:true` 与 `prunedSessions`。

### 3.4 `state.ai`

`buildState` 增加：

```json
{
  "ai": {
    "enabled": false,
    "available": true,
    "provider": "deepseek",
    "model": "deepseek-v4",
    "routeSource": "agent.model.current",
    "reason": null,
    "privacyAccepted": false,
    "impactScan": false,
    "impactScanAvailable": true,
    "impactScanReason": null,
    "busyScopes": ["global"],
    "estimatedInputTokens": 3120,
    "limits": { "maxTokens": 4096, "timeoutMs": 120000, "maxItems": 60 }
  }
}
```

- `enabled`：用户已接受隐私告知（§11）；`available`：当前会话有可用模型路由；
- 前端只有 `enabled && available` 才启用所有 AI 入口；
- `impactScan` 是默认值（配置），不是「本次一定开」；
- `impactScanAvailable=false` 时开关 disabled，`impactScanReason` 给出原因；
- `busyScopes` 返回当前占用的 `scopeKey` 列表，用于按钮禁用与 title。

### 3.5 本地 API 安全

`handleApi`（`lib/index.js:1309`）当前没有认证，任意本地页面都能触发模型调用或改配置。0.6.0 增加：

1. 只接受回环 Host（`127.0.0.1` / `localhost`）；
2. POST 必须 `Content-Type: application/json`；
3. `Origin` 若存在，必须与请求 host 同源；`Sec-Fetch-Site` 只接受 `same-origin` / `none`；
4. 每次运行生成 `state.csrf`，POST 必须带 `x-cc-csrf`；跨源页面读不到响应，拿不到 token；
5. `aiSuggest` 限流：每会话 6 次/分钟、每运行时 20 次/小时，超限 `429`；
6. `aiApply` 只接受服务端缓存 `suggestionId`，不接受任意 op 数组；
7. 错误不回显完整 prompt/配置，只回错误码与安全摘要。

## 4. 模型路由与调用

### 4.1 路由

```js
async function resolveRoute(ctx, sessionId) {
  const agent = await resolveAgent(ctx, sessionId);
  const direct = agent?.model?.current?.();
  if (direct?.provider && direct?.model) {
    return { provider: direct.provider, model: direct.model, source: "agent.model.current" };
  }
  const fallback = ctx.agentDefaultModel?.currentSelection?.();
  if (fallback?.provider && fallback.model) {
    return { provider: fallback.provider, model: fallback.model, source: "agentDefaultModel.currentSelection" };
  }
  return { available: false, reason: "no-route" };
}
```

- **不要**读 `session.requestHeader()?.config`：首次请求前是 `undefined`，还会漏掉 pending selection；
- **不要**把 `agent.options` 当主路径；它只是 `agent.model.current()` 的内部一环；
- **不要**跨会话缓存「最近成功路由」；每个请求按传入 `sessionId` 现算；
- `state.ai.routeSource` 透出来源，排障时能区分两层回退；
- 不读全局模型配置，不新建 provider；无路由时 `available:false`，不阻塞页面。
- **注入方式**：`lib/index.js` 的 `inject` 改为 `{ required: ["systemPrompt", "tools", "webServer"], optional: ["agentDefaultModel"] }`；`agentDefaultModel` 走可选注入，宿主未提供时 `ctx.agentDefaultModel` 为 `undefined`，`resolveRoute` 返回 `routeSource:"none"` / `reason:"no-default-model-service"`，不静默当成无模型。若目标宿主不支持对象式 inject，则用 `ctx.get("agentDefaultModel")` 取可选服务，显式判空；不要只写 `ctx.agentDefaultModel?.` 而不声明注入。

### 4.2 `llm.stream` 契约

```js
const messages = [
  { role: "system", content: [{ type: "text", text: systemPrompt }] },
  { role: "user", content: [{ type: "text", text: userPrompt }] },
];

const info = await ctx.llm.resolveModelInfo?.(provider, model, signal);
const maxTokens = Math.max(256, Math.min(4096, info?.defaultMaxTokens ?? 4096));

const stream = ctx.llm.stream({
  provider,
  model,
  messages,
  maxTokens,
  temperature: 0.2,
  signal,
});
```

事件处理（`lib/ai/llm.js`）：

1. `text-delta`：用 `BlockAssembler`（或本地等价实现）累积 text block；不要只拼字符串后假定成功；
2. `finish`：检查 `finish.kind`；
   - `kind === "error"` → 抛 `llm-error`，带 `failure.code/message`；
   - `kind === "aborted"` → 抛 `AbortError`，映射为 `aborted`，不算配置失败；
   - 正常结束但文本为空 → `empty-output`，不当作成功；
3. `maxTokens` 用 `resolveModelInfo(provider, model, signal)` 的 `defaultMaxTokens` 夹取，并参考 `contextWindow`，不再固定 4096；
4. 120s `AbortController`；超时 abort 会保留 `llm-timeout` 原因，不再显示成“已取消”；
5. **插件内不重试**：传输重试交给 `dsh-llm-retry`；JSON 解析失败直接返回 `bad-json`，避免同一次点击叠两次计费。

### 4.3 请求与解析

- 单次只发一个请求；不并发多个 scope；
- 输出要求严格 JSON；解析前去掉可能出现的 ```json 围栏（只做格式清洗，不改语义）；
- 解析后过 `lib/ai/schema.js`：字段白名单、类型、长度、item 必须来自输入清单；
- 解析失败 → `bad-json`，不写任何配置，UI 显示「模型返回格式不正确，未改动配置」。

### 4.4 提示词边界

System 包含：

- 角色：DSH 上下文审计助手；
- 输入：当前 scope 的条目、token、开关、规则、证据；
- 输出：严格 JSON，不要 markdown 代码块；
- 规则：建议不是结论；不确定降低 confidence；基础工具不可隐藏；不要建议未知 id；
- 隐私：不请求用户消息、工具参数、工具结果。

User 包含：

- scope 与写入层；
- 条目清单（名称、type、token、当前状态、来源）；
- 当前规则/覆盖；
- 窗口与总 token；
- 可选 focus；
- 输出 schema 与 `TYPE_SCOPE_MATRIX` 支持范围。

不发送：

- 用户消息正文；
- 工具调用参数/结果；
- 文件内容（文本改写只发该段正文）；
- 绝对路径（只发 basename）、密钥、完整环境变量。

## 5. 建议结构

```ts
type SuggestionItem = {
  id: string;                 // 稳定 id：type:name / section:name
  type: "cap" | "section" | "context" | "tool";
  name: string;
  action: "keep" | "brief" | "hide" | "on" | "off" | "rewrite";
  text?: string | null;       // 仅 rewrite
  reason: string;
  confidence: "high" | "medium" | "low";
  risk: "low" | "medium" | "high";
  currentTokens: number;
  savedTokens: number;        // 服务端重算
  editable: boolean;
  blocked?: string | null;    // 不可关/作用域不支持/保护项
  impact?: {                  // 仅 impactScan 成功时（§10）
    kind: "degrade" | "block" | "unknown";
    targets: string[];
    evidence: string;
  } | null;
};
```

- `savedTokens` 由服务端按当前 token 与目标档位重算，忽略模型自报值；
- `confidence=low` 的项不默认选中；
- `risk=high` 的项不默认选中，应用时二次确认；
- `blocked` 的项不提供批量应用；单项需显式确认；
- `impact` 只影响展示与默认勾选，不参与 `savedTokens` 合计。

## 6. 事务、应用与撤销

### 6.1 `store.transaction` / `applyOps`

现状（`lib/store.js`）：每个 `set*` 各自 `writeFileAtomic`（`:516/524`、`:623`、`:673/684`、`:796`、`:820`），`state` 只有 `version:3`；20 项 apply 会写 20 次盘，中途异常留下半份配置，并发 apply 互相覆盖。

新增：

```js
// 进程内互斥；所有写操作排队
await store.transaction(async (draft) => {
  // draft 是结构化克隆，可安全改
});

// AI apply 用的受控批量入口
store.applyOps(ops, { revision }); // 全量校验 → 单次落盘 → 返回 { revision, prunedSessions }
```

事务规则：

1. **全量校验**：先跑完所有 op 的矩阵/键名/值域/PROTECTED 校验，任何一条失败整单拒绝，不进入写阶段；
2. **单次落盘**：在 draft 上应用全部 op，`state.revision += 1`，`writeFileAtomic` 一次；`save()` 的「吞异常返回 false」在事务里改为抛 `store-write-failed`；
3. **失败回滚**：写盘失败恢复 `this.state` 原引用与 `revision`，不留下半份；
4. **并发**：`this._tx` 串行化；apply 入口再加一把 `runtime.aiApplyBusy`，重复 apply 返回 `409 busy`；
5. **op 白名单**：`setCap`、`setScopeRule`、`setSessionCap`、`setSessionRule`、`setRuleForMode`；不允许在 AI apply 里 `activate` 模式或改项目结构；
6. **revision**：`modes.json` 顶层新增 `revision: number`（向后兼容，缺失按 0），每次成功事务 +1；读取时按第 7 条显式保留，不用“兜底”代替白名单。
7. **`sanitizeState` 必须显式保留新顶层字段**：当前实现（`lib/store.js:222`）会重建 state，未知字段会被丢掉；若只加 `revision`/`ai` 而不同步白名单，任何 `set*` 保存都会清空 AI 配置与隐私 opt-in。修复：
   ```js
   const state = {
     version: 4,                 // 见下
     revision: Number(raw?.revision) || 0,
     ai: sanitizeAi(raw?.ai),    // enabled:false, impactScan:"off", privacyAcceptedAt:null
     // ...existing fields
   };
   ```
   `sanitizeAi` 只接受白名单键（enabled/impactScan/privacyAcceptedAt），其余丢弃；`impactScan` 只接受 `"off"|"on"`，缺省 `"off"`。
8. **schema version 建议升到 4**：`defaultState()`、`sanitizeState()` 输出 `version:4`；读取 v3 时按默认值补齐 `revision:0`/`ai`，第一次成功写入升级为 v4，不做破坏性迁移。若决定不升版，也必须完成第 7 条显式保留，否则 F2 仍然存在。`modes.json` 的 v3/v4 都按同一 `sanitizeState` 读取，旧插件读到 v4 会忽略新字段但不崩溃。
9. **round-trip 测试**：读入 v3（无 ai/revision）→ 保存任意 `set*` → 再读，`ai` 与 `revision` 不丢；v4 写读一致；`impactScan:"on"` 与 `privacyAcceptedAt` 能保留。

### 6.2 apply 流水线

1. 取服务端缓存的 suggestion，校验 `suggestionId` 存在且未过期；
2. 用当前 state 重算 `fingerprint` 与 `revision`，不一致 → `stale`，返回变化 key；
3. 校验 `modeId`（parts 必须是生成建议时的模式）与 scope/目标层；
4. 逐项过 `TYPE_SCOPE_MATRIX`、`PROTECTED`、`blocked`、`impact.kind=block` 规则；
5. 生成 `ops[]` 与 `undoToken`（旧值来自当前 state，不是模型输出）；
6. `store.applyOps(ops)` 单次落盘；
7. 成功后 `invalidateAfterWrite(runtime)`（§9.3），返回新 state 与 undoToken；
8. 任一步失败：不调用 applyOps，返回具体错误码，配置不变。

### 6.3 `undoToken`

```json
{
  "undoToken": "undo_...",
  "sessionId": "session-...",
  "scopeKey": "parts|default-workspace|session-...|context-control",
  "modeId": "context-control",
  "revision": 42,
  "at": 1760000000000,
  "expiresAt": 1760003600000,
  "items": [
    { "kind": "sections", "key": "harness:identity", "layer": "parts", "previous": { "enabled": false, "hidden": true } }
  ],
  "prunedSessions": []
}
```

- `previous` 是**完整旧规则**（含 `enabled/text/hidden`），不是模型给的 previous；
- undo 前重新读 store：
  - `activeModeId !== modeId` → 拒绝（`mode-switched`）；
  - `store.revision !== revision` → 拒绝（`conflict`），返回冲突 key；
- 撤销本身也走 `store.transaction`，成功后 revision 再 +1；
- 旧规则不存在（被删/被剪枝）→ 标 `undoPartial:true`，只恢复仍存在的项，并列出未恢复项。

### 6.4 部分失败与过期

- apply 是 all-or-nothing，不存在「部分成功」；`skipped` 只用于「建议里被过滤掉的非法项」，在写之前返回；
- undo 允许 `undoPartial`（会话剪枝/手工删规则导致），但必须逐项列出；
- undo 过期（>1h）→ `410 undo-expired`，UI 移除撤销按钮并说明「本次会话内可撤销，已过期」。

## 7. 语义与证据

### 7.1 hide / brief

| 目标 | cap 值 | 规则形态 | 正文 | 简介 | `savedTokens` |
| --- | --- | --- | --- | --- | --- |
| 加载 | `true` | `enabled:true` | 发 | — | 0 |
| 简介 | `false` | `enabled:false` | 不发 | 发一行 | `current - briefTokens` |
| 隐藏 | `"hidden"` | `enabled:false, hidden:true` | 不发 | 不发 | `current` |

现状问题：`scopeBriefItems`（`lib/index.js:503`）与 `modeBriefItems`（`:533`）把所有 `enabled:false` 自动写进简介，只有 cap 的 `hidden` 在 `capabilities.js:318-336` 被排除。0.6.0：

1. 规则白名单增加 `hidden: boolean`（`sanitizeRules` / `sanitizeScopeRules` 同步）；
2. `scopeBriefItems` / `modeBriefItems` 跳过 `rule.hidden === true`；
3. cap 的隐藏继续用 `"hidden"`，不写规则级 `hidden`；
4. `hidden` 与 `text` 互斥：`hidden` 时忽略 `text`，校验期直接拒绝同时出现；
5. `savedTokens` 按上表由服务端重算：隐藏按全量，简介按「原文 − 简介行」，不能把 4.2k 写成 −3.8k。

### 7.2 parts 的 cap / skill

- `parts` 没有 cap 存储，`setRule` 也不接受 cap；0.6.0 **不扩展**模式 cap；
- 构成页 AI 只建议 section/context/tool：开关、简介、文本改写；
- 技能行不是独立规则，AI 不建议「隐藏某个技能」，只允许对包含它的目录段做段级操作（UI 不主动提供）；
- 若模型仍返回 cap/skill 项，schema 层丢弃并 warning「构成页不支持能力档位」。

### 7.3 指纹

```text
fingerprint = sha256(canonicalJson({
  scope, scopeKey, storeRevision,
  caps: 按 key 排序的当前作用域有效档位,
  rules: 按 kind/key 排序的当前层规则（仅 enabled/text/hidden）,
  inventory: 按 type/key 排序的 [{ type, key, name, tokens, textHash? }],
  modeId, projectId, sessionId
}))
```

- `inventory.textHash` 用段文本的 sha256 前 16 位，不发全文；
- `prompt.total` / `projected.total` **不参与**哈希，只用于展示；否则每次估算波动都会误判 stale；
- `impact.digest` 也不参与 apply 的 fingerprint（§10.5）；
- apply 前重算，不一致返回 `stale` 与变化 key；
- 任何成功写操作使旧指纹自然失效。

### 7.4 snapshot

- AI 证据只接受**该 session 自己的** snapshot：`runtime.snapshots.get(sessionId)`；
- 不允许 `?? runtime.snapshots.latest()`（`lib/index.js:294`、`:585` 的跨会话回退会让 A 会话拿到 B 会话证据）；
- 没有该 session 的 snapshot → `evidence.available:false, reason:"no-session-snapshot"`，不生成建议、不 fallback；
- `buildState`（`:756`）里把 `sessionId` 当 snapshot key 是现有实现，保留，但 AI 路径必须显式传 sessionId 并在缺失时失败；
- capabilityCatalog 为 AI 增加 `strictSession` 参数：`strictSession=true` 时不允许 latest 回退。

### 7.5 「隐藏能力 = 其 sections/tools 全隐藏」是启发式

`capabilities.js:98-107` 只按首个冒号前缀且排除 RESERVED；`pluginOfTool` 靠硬编码别名/提示。0.6.0：

- `capPlan` 返回 `unresolved`：无法归到 cap 的 sections/tools；
- 建议里 `warnings` 写「N 项无法归因，未计入隐藏范围」，不承诺「全部隐藏」；
- `minimal` 只统计已识别项；unresolved 保留原状，默认不勾选。

### 7.6 其他插件的 restrict

- `liveToolNames(runtime)`（`:146`）目前不传 scope，只看到全局工具；
- 需要 `schemas(agent)` 与全局 `schemas()` 的差集，再减去本插件自己的 deny，得到 `foreign.restrictedTools`；
- `syncAgentRestriction`（`:163`）只挂自身 deny；foreign 只读展示，不尝试改写别人的限制；
- `state`/impact 里暴露 `foreignRestricted`，UI 标「已被其他插件/agent 限制」，避免把「本来就没加载」误判为「可以隐藏」。

## 8. 硬护栏

### 8.1 `PROTECTED`

`lib/ai/schema.js` 定义单一事实源：

```js
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
  // 前缀兜住不在 catalog 的自有工具/宿主工具
  toolPrefixes: ["context_control_", "ops_", "acp_"],
  caps: new Set([
    "plugin:context-control",
    "plugin:dsh-ops",
    "plugin:billion-context",
    "plugin:terminal",
  ]),
  sections: new Set(["context-control:brief"]),
});
```

- 保护项只允许 `keep`；`brief`/`hide`/`off` 一律降级为 `keep` + `blocked:"受保护项"`；
- **cap 必须先展开再判断**：`checkGuard(item)` 遇到 `type:"cap"` 时，先按该 cap 的 `capPlan` 展开成 sections/tools，再逐个过 `PROTECTED.tools/toolPrefixes/sections`；命中任意一项就拒绝整个 cap 的 `brief`/`hide`，不能只看 cap key。否则 `plugin:dsh-ops`（文件读写）、`plugin:billion-context`（压缩）、`plugin:terminal`（终端）可以整包隐藏，绕过工具级保护。
- 本插件自身工具不在 catalog（`capabilities.js:51-76` 没有 `context_control_*`，`RESERVED_PREFIXES` 又排除 `context:`），所以必须用前缀常量兜住；`ops_*` 与 `acp_*` 同样按实际工具名/前缀补齐，不能只列 `run_code`。
- `run_code` 是 PTC 传输工具，`dsh-tools` 明确 restrict 不能命名它；见 §8.2；
- 常量与 UI 文案共用一份导出，避免「文档说保护、代码没拦」。
- 验收测试必须覆盖：`cap:plugin:dsh-ops` / `billion-context` / `terminal` 的 hide 被拒；capPlan 展开后命中 `ops_*`/`acp_*` 的工具被拒；suggest 与 apply 两侧都拒绝。

### 8.2 `run_code` 宿主级例外

- 本插件**不能**通过规则或 `tools.restrict()` 关闭/限制 `run_code`：宿主会拒绝命名该工具，PTC 子调用继承 allow/deny，但「禁止 `run_code` 本身」必须在宿主/执行器层处理；
- 因此：`run_code` 在 `PROTECTED.tools` 里，建议侧永不生成 hide/off；apply 侧即使收到也拒绝；
- 若用户在别的层已有 `run_code` deny，本插件不复制、不加剧，只展示「宿主级保护，插件无法关闭」；
- 验收测试必须覆盖「建议隐藏 run_code → 被降级」「apply 传 run_code → 拒绝」。

### 8.3 suggest / apply 双校验

同一个 `checkGuard(item, target)` 在两处调用：

1. suggest：模型输出逐项过滤，非法项丢弃并 warning；
2. apply：按服务端缓存重新校验，任何一项失败整单拒绝。

校验顺序：`type` 合法 → `key/name` 在证据清单 → 矩阵支持 → **cap 先 `capPlan` 展开并逐项过 PROTECTED** → `text` 只允许 sections/contexts 且 ≤ 原文 150% → `savedTokens` 重算 → `hidden/text` 互斥。

## 9. 缓存与并发

### 9.1 `scopeKey`

```text
scopeKey = `${scope}|${projectId ?? "-"}|${sessionId ?? "-"}|${modeId ?? "-"}`
```

- `global` 不依赖 session/project，但保留占位，避免不同层共键；
- `parts` 必须含 `modeId`，切模式即换 key；
- `item` 在 scopeKey 后再加 `|item:${id}`，行内结果不污染页面级缓存。

### 9.2 `aiCache` / `aiBusy`

- `runtime.aiCache: Map<scopeKey, { suggestion, at, fingerprint, impactScan }>`；TTL 15 分钟，最多 8 条；key 含 `impactScan`，开关变化不会命中旧口径；
- `runtime.aiBusy: Map<scopeKey, { at, sessionId }>`：每个 key 一把锁，重复请求 409；
- `runtime.aiSessionBusy: Map<sessionId, scopeKey>`：同一会话同时只跑一个 AI 任务，跨 scope 也 409，返回占用中的 scope；
- 页面切换/项目切换不取消服务端任务，但回包按 scopeKey 丢弃；
- 缓存命中不再调用模型。

### 9.3 apply 后失效

只清 `aiCache` 不够。统一 `invalidateAfterWrite(runtime)`：

```text
aiCache.clear()
catalogCache.clear()
effectiveByAgent.clear()
capDiag = null
agentRestrictions.dispose + clear
lastError = ""
snapshots 不主动清（下一次装配会覆盖）
```

`runAction` 里现有的零散清理（`:991`、`:1080`、`:1648`）合并到该函数，避免漏项。

## 10. 可选影响分析（`impactScan`）

### 10.1 配置与开关

`modes.json` 新增：

```json
"ai": { "enabled": false, "impactScan": "off", "privacyAcceptedAt": null }
```

- `impactScan` 取值 `"off" | "on"`，默认 `"off"`；
- 请求字段 `impactScan?: boolean` 优先于配置；
- `buildState.ai.impactScan` 暴露默认值，`impactScanAvailable` 暴露证据是否齐全；
- 开启一次 = 主建议成功后再发 **1 次**模型调用；关闭不产生额外调用；
- UI 切换开关只标 stale，不自动重跑（§10.6）。

### 10.2 证据来源（只读）

| 来源 | 用途 | 限制 |
| --- | --- | --- |
| 本会话 snapshot | 段/上下文/工具与 token | 只取该 session，不回退 latest |
| catalog | section↔cap、tool↔cap 归组 | 前缀/提示是启发式，标 low |
| live tools `schemas()` / `schemas(agent)` | 差集 → foreign | 只读，不改别人限制 |
| `pluginInventory`（Remote） | 插件 id/enabled/phase | 只有 id/module/enabled/phase，无依赖边 |
| 规则表（global/projects/modes/sessions） | orphan 检测 | 只查 key 是否还在 catalog/实时工具名 |

### 10.3 契约

按评审 §3，`related.confidence` 固定 `"low"`；`annotations` 是 t3 需要的逐条映射扩展。

```ts
type Impact = {
  available: boolean;
  reason?: "no-session-snapshot" | "no-tools" | "impact-model-failed" | "privacy-off";
  at: number;
  source: { snapshot: "session" | null; tools: "scoped" | "global" | null; loader: boolean };
  plugins?: Array<{ id: string; enabled: boolean; phase?: string }>;
  related: Array<{
    key: string;
    kind: "skill" | "mcp" | "plugin";
    name: string;
    confidence: "low";
    sections: string[];
    tools: string[];
    basis: "prefix" | "hint" | "mcp" | "rule";
  }>;
  unattributed: {
    sections: Array<{ name: string; tokens: number; why: "reserved" | "unknown" }>;
    tools: Array<{ name: string; why: "unknown" | "mcp" }>;
  };
  foreign: { restrictedTools: string[]; restrictedSections: string[] };
  orphans: Array<{ scope: string; kind: string; key: string; why: "target-missing" }>;
  unexplainedTokens: number;
  digest: string; // "sha256:..."
  annotations: Array<{
    itemKey: string;
    targetKey: string;
    kind: "degrade" | "block" | "unknown";
    evidence: string;
  }>;
};
```

- `unexplainedTokens = max(0, snapshot 总 token − related/unattributed 已归因 token)`，只展示，不参与判定；
- `digest = sha256(canonicalJson(impact 去掉 at/digest))`，用于展示与缓存，不参与 apply 阻塞指纹；
- UI 把 `annotations` 渲染成每条建议下的 `impacts[]` 行（`itemKey/targetKey/kind/evidence`）。

### 10.4 二次调用与校验

1. 服务端先确定性组装证据（related/unattributed/foreign/orphans/plugins），不依赖模型；
2. `impactScan=true` 且 `available` 时，发第二次 `llm.stream`：输入证据包 + 主建议 items，输出只允许 `{ annotations: [...] }`；
3. 逐条校验：
   - `itemKey` 必须存在；
   - `targetKey` 必须出现在 evidence（related/orphans/foreign/plugins）里；
   - `evidence` 必须是已有事实的摘要，≤160 字符，不能引入新事实；
4. 服务端重算 `unexplainedTokens` 与 `digest`，模型给的值一律忽略；
5. `block` 需要硬证据（foreign 命中、orphan 将被创建、或 exact mcp 关联），否则降级 `unknown` 并 warning；
6. 第二次调用失败：`available:false, reason:"impact-model-failed"`，主建议仍可用；不重试、不阻塞 apply。

### 10.5 advisory 边界

- 影响分析**只做提示**：不自动 hide、不自动 apply、不改变 `savedTokens`、不参与 fingerprint；
- `block` 项默认不勾选、不进批量；单项应用需 `confirmBlocked:true`；
- `related` 永远显示「可能相关（推测）」，不写因果结论；
- 关闭开关：客户端清空 `impact`、重算影响合计，主建议与勾选保持；
- 切换开关：只标「口径已变更，请重新分析。」，不自动发请求；
- 证据不足时宁可不显示，不用「未知」冒充分析结果。

### 10.6 UI 约定（细节见 UI 文档）

- `AiImpactToggle` 放 AiCard 头部右侧（覆盖率/上次时间之后），会话 sheet 也可放在补充说明下方；
- 默认文案「仅分析本层」；勾选后「含其他插件/工具影响」；
- 勾选提示「多 1 次模型调用 · +1.2s」，title 说明不查依赖的风险；
- 结果卡头显示「含影响分析」+「N 项有阻断风险」可筛；
- 每条建议下 11px sub-line：降级用 warn 文字、阻断用 err + 「需确认」、未知用 ink2；
- 430px 最多显示 1 条 + `+N`；
- 关闭开关后清空 impacts 并重算合计。

### 10.7 失败与边界

- 没有该 session snapshot → `available:false`，开关 disabled；
- 没有实时工具表 → `source.tools:null`，foreign 为空并 warning；
- `pluginInventory` 不可用 → `source.loader:false`，`plugins` 省略；
- 证据里出现未知前缀：进 `unattributed`，不强行归因；
- impact digest 相同不重复展示「影响分析已更新」。

## 11. 隐私与成本

1. **默认关闭**：`ai.enabled=false`，未接受告知前所有 AI 入口 disabled，`aiSuggest` 返回 `403 privacy-not-accepted`；
2. 首次启用展示：发送的字段清单、不发送的字段、provider/model、估算输入 token、是否开启影响分析；
3. 接受后写 `ai.enabled=true`、`privacyAcceptedAt`；可在面板里关闭并清空缓存；
4. 发送前 secret 扫描（`sk-`、`ghp_`、`AKIA`、`Bearer` 等）与截断；命中即替换为 `[redacted]` 并 warning；
5. 不发送用户消息、工具参数/结果、文件内容、绝对路径；
6. `state.ai` 展示 provider/model/routeSource/估算输入 token，让用户知道发给谁、发多少；
7. 成本控制：单击才调用、缓存、单会话单任务、`maxItems=60`、输出 ≤4096、影响分析最多 +1 次调用。

## 12. 会话剪枝

`MAX_SESSION_CAPS = 50`（`lib/store.js:129`），`setSessionCap` 每次 `pruneSessions`（`:653`）。AI 批量写会话层可能挤掉旧会话，导致 undo 失败。0.6.0：

- 单次 `aiSuggest` 的会话级 item 上限 12；
- apply 前检查「写入后是否会 prune 其他 session」；
- 会 prune 时默认拒绝，返回 `409 session-prune` 与将被挤掉的 sessionId 列表；
- 用户显式 `allowSessionPrune:true` 才继续；`undoToken.prunedSessions` 记录，undo 时标 `undoPartial`；
- UI 确认文案写明「将挤掉最久未用的 N 条会话覆盖，撤销无法恢复」。

## 13. 文件

```text
lib/ai/context.js      证据、脱敏、snapshot、fingerprint
lib/ai/prompts.js      四类 prompt + impact 二次调用 prompt
lib/ai/llm.js          路由、stream/BlockAssembler、finish 检查、超时
lib/ai/schema.js       TYPE_SCOPE_MATRIX、PROTECTED、校验、savedTokens
lib/ai/impact.js       影响证据、契约、digest、annotations 校验
lib/ai/apply.js        事务 ops、apply、undo
lib/store.js           revision、transaction/applyOps、hidden 字段
lib/index.js           state.ai、aiSuggest/aiApply/aiUndo、CSRF、失效
client.js              AiStrip/AiPill/AiCard/AiDiff/AiFilter/AiSheet/AiPopover/AiImpactToggle
docs/AI建议-UI设计.md  已按 t3 修订
docs/AI建议-架构方案.md 本文件
test/ai-*.test.mjs     mock llm + 临时 dataDir
```

版本：实现完成后升 `0.6.0`；不发布、不改 `modes.json` 既有字段语义（只做加法）。

## 14. 测试

用 `node --test` + mock `llm.stream` + 临时 `dataDir`，不联网。

### 14.1 作用域与事务

1. 矩阵：每种 type×scope 组合只调用允许的原语；context 在 global/project/session 被拒绝；
2. 20 项 apply 只写 1 次盘；第 10 项非法时 0 次写盘、state 不变；
3. 写盘抛错 → revision 与 state 回滚，无半份配置；
4. 并发两次 apply → 一次 200、一次 409；
5. `parts` 建议 cap/skill → schema 丢弃 + warning；
6. 继承行写入当前层 → 生成覆盖，不修改父层。

### 14.2 undo

7. apply 后切模式再 undo → `mode-switched`，不写；
8. apply 后手工改配置再 undo → `conflict`，列出 key；
9. 1 小时后 undo → `undo-expired`；
10. 会话剪枝后 undo → `undoPartial`，只恢复仍存在项。

### 14.3 模型与流

11. `requestHeader` 无值时不使用；路由顺序 `agent.model.current` → `agentDefaultModel.currentSelection` → unavailable；
12. 不同 session 不共享「最近路由」；
13. `finish.kind=error` → 失败，不写；`aborted` → aborted；空文本 → `empty-output`；
14. content blocks 入参形状正确；`maxTokens` 被 `resolveModelInfo` 夹取；
15. 120s abort 能中断 stream，并返回“模型调用超时（120 秒）”；
16. 插件内不对 bad-json 重试（mock 调用次数为 1）。

### 14.4 语义与证据

17. `hidden:true` 的段/工具不进 brief；`false` 进 brief；`hidden` 省量=全量；
18. fingerprint 对 rules/caps/inventory/revision 变化敏感，对 total 波动不敏感；
19. 跨会话 snapshot 不命中；没有本会话 snapshot → `available:false`；
20. foreign restrict 差集正确，且不修改别人的 deny；
21. capPlan unresolved 进 warning，不承诺全隐藏；
22. apply 后 aiCache/catalogCache/effectiveByAgent/capDiag/agentRestrictions 全部失效。

### 14.5 安全与影响分析

23. 无 CSRF / 跨源 Origin / 非 JSON Content-Type → 拒绝；
24. aiSuggest 超限 → 429；aiApply 伪造 suggestionId → 拒绝；
25. 隐私未接受 → 403；secret 被 redact；不发送消息/工具参数/绝对路径；
26. impactScan 默认 off，不产生第二次调用；on 时只多 1 次；
27. impact 只接受 evidence 内 targetKey；block 无硬证据降级 unknown；
28. impact digest 确定性；digest 不参与 apply fingerprint；
29. blocked 项批量 apply 拒绝；单项需 `confirmBlocked`；
30. 关闭 impactScan 后 impacts 清空、合计重算，主建议不变。
31. cap 展开保护：`plugin:dsh-ops` / `billion-context` / `terminal` 的 hide 被拒；`ops_*` / `acp_*` 命中被拒；suggest 与 apply 两侧都拒绝。
32. 持久化：v3 读入 → 任意 set* 保存 → `ai`/`revision` 不丢；v4 写读一致；`privacyAcceptedAt` 保留。
33. `agentDefaultModel` 可选注入：服务缺失时 `routeSource:"none"`，不静默变成无模型；对象式 inject 不可用时 `ctx.get` 路径有测试。

## 15. 风险

| 风险 | 处理 |
| --- | --- |
| 模型输出坏 JSON | 严格校验、不重试、失败不写 |
| 建议不可靠 | 证据、置信度、风险、用户确认、影响分析只做 advisory |
| 全局误操作 | 二次确认、预览、事务、撤销 |
| 成本/延迟 | 单击才调用、缓存、单并发、输出上限、影响分析默认关闭 |
| 提示注入 | 文本作数据、无工具、schema 校验、二次调用只收 annotations |
| 配置变化 | revision + fingerprint + stale |
| 路由缺失 | `ai.available=false`，不阻塞页面 |
| context 跨层 | 0.6.0 明确限制，v4 再扩展 |
| run_code | 宿主级例外，本插件不承诺可关 |
