import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModeStore } from "../lib/store.js";
import { createAiService } from "../lib/ai/service.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ai-"));
  return new ModeStore({ dataDir: dir });
}

function fakeLlm(items) {
  return {
    stream() {
      const text = JSON.stringify({ items });
      return (async function* () {
        yield { type: "text-delta", delta: { text } };
        yield { type: "finish", finish: { kind: "stop" } };
      })();
    },
  };
}

function evidence(overrides = {}) {
  return {
    scope: "global",
    writeScope: "global",
    scopeId: "global",
    projectId: "default",
    sessionId: null,
    modeId: null,
    revision: 0,
    scopeKey: "global:global:global",
    items: [
      { id: "cap:mcp:github", type: "cap", name: "mcp:github", tokens: 100, enabled: true, currentValue: null, currentRule: null },
      { id: "section:demo", type: "section", name: "demo", tokens: 50, enabled: true, currentRule: null },
      { id: "tool:read", type: "tool", name: "read", tokens: 30, enabled: true, currentRule: null },
    ],
    route: { provider: "demo", model: "demo-model" },
    ...overrides,
  };
}

test("suggest 校验、计算 savedTokens、应用与撤销", async () => {
  const store = tempStore();
  store.setAi({ enabled: true, privacyAcceptedAt: "2026-11-08T00:00:00Z" });
  const service = createAiService({
    store,
    collect: async () => ({ ...evidence(), revision: store.revision }),
    llm: fakeLlm([
      { id: "cap:mcp:github", action: "hide", reason: "未使用", confidence: "high", risk: "low" },
      { id: "section:demo", action: "brief", reason: "太长", confidence: "medium", risk: "low" },
      { id: "tool:read", action: "hide", reason: "基础工具", confidence: "high", risk: "high" },
    ]),
  });

  const suggestion = await service.suggest({ scope: "global" });
  assert.equal(suggestion.items.length, 3);
  const cap = suggestion.items.find((item) => item.id === "cap:mcp:github");
  assert.equal(cap.action, "hide");
  assert.equal(cap.savedTokens, 100);
  assert.equal(suggestion.savedTokens, 130);
  const read = suggestion.items.find((item) => item.id === "tool:read");
  assert.equal(read.action, "keep");
  assert.match(read.blocked, /受保护/);

  const applied = await service.apply({ suggestionId: suggestion.id, confirm: true });
  assert.equal(applied.applied.length, 2);
  assert.equal(store.global().caps["mcp:github"], "hidden");
  assert.equal(store.scopeRules("global").sections.demo.enabled, false);

  const undone = await service.undo({ undoToken: applied.undoToken });
  assert.equal(undone.restored.length, 2);
  assert.equal(store.global().caps["mcp:github"], undefined);
  assert.equal(store.scopeRules("global").sections.demo, undefined);
});

test("suggest 未启用 / 未确认隐私会被拒绝", async () => {
  const store = tempStore();
  const service = createAiService({ store, collect: async () => evidence(), llm: fakeLlm([]) });
  await assert.rejects(() => service.suggest({}), /未启用/);
  store.setAi({ enabled: true });
  await assert.rejects(() => service.suggest({}), /隐私/);
});

test("apply 需要 confirm，revision 变化会拒绝", async () => {
  const store = tempStore();
  store.setAi({ enabled: true, privacyAcceptedAt: "2026-11-08T00:00:00Z" });
  const service = createAiService({
    store,
    collect: async () => ({ ...evidence(), revision: store.revision }),
    llm: fakeLlm([{ id: "cap:mcp:github", action: "hide", reason: "x", confidence: "high", risk: "low" }]),
  });
  const suggestion = await service.suggest({});
  await assert.rejects(() => service.apply({ suggestionId: suggestion.id }), /确认/);
  store.setAi({ enabled: true });
  await assert.rejects(
    () => service.apply({ suggestionId: suggestion.id, confirm: true }),
    /变化|过期/,
  );
});

import { resolveRoute } from "../lib/ai/service.js";

test("provider 未注册时退回已注册 provider，而不是 NO_ADAPTER", async () => {
  const ctx = {
    get(name) {
      if (name !== "llm") return undefined;
      return {
        async listProviders() { return [{ id: "deepseek-official" }]; },
        async listModels(provider) { return provider === "deepseek-official" ? [{ id: "deepseek-flash" }] : []; },
      };
    },
  };
  const agent = { model: { current: () => ({ provider: "sutongapi", model: "deepseek-v4.1-flash" }) } };
  const route = await resolveRoute(ctx, agent);
  assert.deepEqual(route, { provider: "deepseek-official", model: "deepseek-flash", source: "fallback" });
});

test("provider 已注册时保留当前 agent 路由", async () => {
  const ctx = {
    get(name) {
      if (name !== "llm") return undefined;
      return { async listProviders() { return [{ id: "sutongapi" }]; } };
    },
  };
  const agent = { model: { current: () => ({ provider: "sutongapi", model: "m" }) } };
  const route = await resolveRoute(ctx, agent);
  assert.equal(route.source, "agent");
  assert.equal(route.provider, "sutongapi");
});
