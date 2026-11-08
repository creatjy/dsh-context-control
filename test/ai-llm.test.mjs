import test from "node:test";
import assert from "node:assert/strict";
import { callJson, collectStream } from "../lib/ai/llm.js";

const streamOf = (events) => (async function* () {
  for (const event of events) yield event;
})();

test("finish.reason=max-tokens 会报告可诊断错误", async () => {
  await assert.rejects(
    () => collectStream(streamOf([
      { type: "reasoning-delta", text: "thinking..." },
      { type: "finish", reason: { kind: "max-tokens" } },
    ])),
    (error) => error.code === "max-tokens" && /maxTokens/.test(error.message),
  );
});

test("有文本但被 max-tokens 截断也会重试", async () => {
  const calls = [];
  const llm = {
    stream(options) {
      calls.push(options.maxTokens);
      if (calls.length === 1) {
        return streamOf([
          { type: "text-delta", text: "{\"items\":[{\"id\":\"x\"" },
          { type: "finish", reason: { kind: "max-tokens" } },
        ]);
      }
      return streamOf([
        { type: "text-delta", text: "{\"items\":[]}" },
        { type: "finish", reason: { kind: "stop" } },
      ]);
    },
  };
  const result = await callJson({
    llm,
    route: { provider: "p", model: "m" },
    system: "s",
    user: "u",
    maxTokens: 4096,
  });
  assert.deepEqual(result, { items: [] });
  assert.deepEqual(calls, [4096, 8192]);
});

test("空输出会放宽 maxTokens 重试一次", async () => {
  const calls = [];
  const llm = {
    stream(options) {
      calls.push(options.maxTokens);
      if (calls.length === 1) {
        return streamOf([{ type: "finish", reason: { kind: "max-tokens" } }]);
      }
      return streamOf([
        { type: "text-delta", text: "```json\n{\"items\":[]}\n```" },
        { type: "finish", reason: { kind: "stop" } },
      ]);
    },
  };
  const result = await callJson({
    llm,
    route: { provider: "p", model: "m" },
    system: "s",
    user: "u",
    maxTokens: 4096,
  });
  assert.deepEqual(result, { items: [] });
  assert.deepEqual(calls, [4096, 8192]);
});
