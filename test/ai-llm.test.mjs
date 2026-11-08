import test from "node:test";
import assert from "node:assert/strict";
import { callJson, collectStream, withTimeout } from "../lib/ai/llm.js";

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


test("超时 abort 会保留 llm-timeout 原因，而不是显示已取消", async () => {
  const { signal } = withTimeout(undefined, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason?.code, "llm-timeout");
  await assert.rejects(
    () => collectStream((async function* () {
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield { type: "text-delta", delta: { text: "x" } };
    })(), { signal }),
    (error) => error.code === "llm-timeout" && /超时/.test(error.message),
  );
});
