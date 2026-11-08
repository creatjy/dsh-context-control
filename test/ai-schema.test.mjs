import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTECTED,
  checkGuard,
  isProtectedTool,
  matrixSupports,
  sanitizeSuggestionItem,
} from "../lib/ai/schema.js";

test("受保护工具按名单与前缀命中", () => {
  assert.equal(isProtectedTool("bash"), true);
  assert.equal(isProtectedTool("run_code"), true);
  assert.equal(isProtectedTool("ops_stat"), true);
  assert.equal(isProtectedTool("acp_status"), true);
  assert.equal(isProtectedTool("context_control_open"), true);
  assert.equal(isProtectedTool("read_file"), false);
});

test("受保护 cap 不能整包隐藏；展开后命中工具也拒绝", () => {
  assert.equal(checkGuard({ type: "cap", key: "plugin:dsh-ops", action: "hide" }).ok, false);
  const guard = checkGuard(
    { type: "cap", key: "plugin:some-ops", action: "brief" },
    { expandCap: () => ({ sections: [], tools: ["ops_stat"] }) },
  );
  assert.equal(guard.ok, false);
  assert.match(guard.blocked, /ops_stat/);
});

test("受保护项 action=keep 仍允许", () => {
  assert.deepEqual(checkGuard({ type: "tool", key: "bash", action: "keep" }), {
    ok: true,
    action: "keep",
    blocked: null,
    reason: null,
  });
  assert.equal(checkGuard({ type: "tool", key: "read", action: "hide" }).action, "keep");
});

test("矩阵拒绝 context 写全局/项目/会话", () => {
  assert.equal(matrixSupports("context", "global"), false);
  assert.equal(matrixSupports("context", "parts"), true);
  assert.equal(matrixSupports("cap", "parts"), false);
  assert.equal(matrixSupports("section", "session"), true);
});

test("sanitizeSuggestionItem 丢弃未知 id、限制改写类型", () => {
  const items = [{ id: "tool:bash", type: "tool", name: "bash", tokens: 100 }];
  assert.equal(sanitizeSuggestionItem({ id: "tool:nope", action: "hide" }, { items }).item, null);
  const hidden = sanitizeSuggestionItem(
    { id: "tool:bash", action: "hide", reason: "少用", confidence: "high", risk: "low" },
    { items },
  ).item;
  assert.equal(hidden.action, "keep");
  assert.ok(hidden.blocked);
  assert.equal(hidden.savedTokens, 0);
});

test("PROTECTED 名单包含 run_code 与 acp 工具", () => {
  assert.equal(PROTECTED.tools.has("run_code"), true);
  assert.equal(PROTECTED.tools.has("acp_cache"), true);
  assert.equal(PROTECTED.caps.has("plugin:billion-context"), true);
});
