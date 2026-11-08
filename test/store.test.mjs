import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModeStore, sanitizeState } from "../lib/store.js";

function tempStore(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-store-"));
  const file = path.join(dir, "modes.json");
  if (seed) fs.writeFileSync(file, JSON.stringify(seed), "utf8");
  return { store: new ModeStore({ dataDir: dir }), file };
}

test("v3 状态读入后升级到 v4，并保留 ai/revision", () => {
  const { store } = tempStore({
    version: 3,
    activeModeId: "context-control",
    revision: 7,
    ai: { enabled: true, impactScan: "on", privacyAcceptedAt: "2026-11-08T00:00:00Z" },
  });
  assert.equal(store.state.version, 4);
  assert.equal(store.revision, 7);
  assert.equal(store.ai().enabled, true);
  assert.equal(store.ai().impactScan, "on");
});

test("save 成功一次 revision +1，失败不递增", () => {
  const { store } = tempStore();
  const before = store.revision;
  assert.equal(store.save(), true);
  assert.equal(store.revision, before + 1);
  const original = store.file;
  store.file = store.dir;
  assert.equal(store.save(), false);
  store.file = original;
  assert.equal(store.revision, before + 1);
});

test("v3 读入后第一次写盘升级 v4，ai/revision 不丢", () => {
  const { store, file } = tempStore({
    version: 3,
    activeModeId: "context-control",
    ai: { enabled: true, impactScan: "on", privacyAcceptedAt: "2026-11-08T00:00:00Z" },
  });
  const before = store.revision;
  store.setAi({});
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.version, 4);
  assert.equal(onDisk.revision, before + 1);
  assert.equal(onDisk.ai.enabled, true);
  assert.equal(onDisk.ai.impactScan, "on");
  assert.equal(onDisk.ai.privacyAcceptedAt, "2026-11-08T00:00:00Z");
});

test("能力联动写入段落/工具规则，并可撤销", () => {
  const { store, file } = tempStore();
  const linked = { sections: ["agent-teams:usage"], tools: ["agent_teams_create"] };
  assert.equal(store.setScopeLinked("workspace", linked, true), 2);
  assert.equal(store.state.projects[0].sections["agent-teams:usage"].enabled, true);
  assert.equal(store.state.projects[0].sections["agent-teams:usage"].auto, true);
  assert.equal(store.state.projects[0].tools["agent_teams_create"].enabled, true);

  store.setScopeRule("workspace", "sections", "agent-teams:usage", { text: "自定义说明" });
  assert.equal(store.state.projects[0].sections["agent-teams:usage"].auto, undefined);
  assert.equal(store.clearScopeLinked("workspace", linked), 1);
  assert.equal(store.state.projects[0].sections["agent-teams:usage"].text, "自定义说明");
  assert.equal(store.state.projects[0].tools["agent_teams_create"], undefined);

  store.setSessionLinked("session-1", linked, false);
  assert.equal(store.state.sessions["session-1"].sections["agent-teams:usage"].enabled, false);
  assert.equal(store.state.sessions["session-1"].tools["agent_teams_create"].enabled, false);
  store.clearSessionLinked("session-1", linked);
  assert.equal(store.state.sessions["session-1"], undefined);

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.projects[0].sections["agent-teams:usage"].text, "自定义说明");
});

test("联动 auto 标记持久化，重启后仍可撤销", () => {
  const { store, file } = tempStore();
  const linked = { sections: ["agent-teams:usage"], tools: ["agent_teams_create"] };
  store.setScopeLinked("workspace", linked, true);
  const reloaded = new ModeStore({ dataDir: path.dirname(file) });
  assert.equal(reloaded.state.projects[0].sections["agent-teams:usage"].auto, true);
  assert.equal(reloaded.state.projects[0].tools["agent_teams_create"].auto, true);
  assert.equal(reloaded.clearScopeLinked("workspace", linked), 2);
  assert.equal(reloaded.state.projects[0].sections["agent-teams:usage"], undefined);
  assert.equal(reloaded.state.projects[0].tools["agent_teams_create"], undefined);
});

test("applyOps 一次写盘，setCap + setScopeRule 同批生效", () => {
  const { store, file } = tempStore();
  const before = store.revision;
  const revision = store.applyOps(
    [
      { op: "setCap", scopeId: "workspace", key: "mcp:github", value: "hidden" },
      { op: "setSessionRule", sessionId: "s1", kind: "sections", key: "toolbox:catalog", patch: { enabled: false } },
    ],
    { revision: before },
  );
  assert.equal(revision, before + 1);
  assert.equal(store.state.projects[0].caps["mcp:github"], "hidden");
  assert.equal(store.state.sessions.s1.sections["toolbox:catalog"].enabled, false);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.revision, before + 1);
});

test("applyOps revision 过期拒绝且不改 state", () => {
  const { store } = tempStore();
  const before = store.revision;
  assert.throws(
    () => store.applyOps([{ op: "setCap", scopeId: "workspace", key: "mcp:github", value: false }], { revision: before + 10 }),
    (error) => error.code === "conflict" && error.currentRevision === before,
  );
  assert.equal(store.revision, before);
  assert.equal(store.state.projects[0].caps["mcp:github"], undefined);
});

test("applyOps 中途失败回滚，不产生半套规则", () => {
  const { store } = tempStore();
  const before = JSON.stringify(store.state);
  assert.throws(() =>
    store.applyOps([
      { op: "setCap", scopeId: "workspace", key: "mcp:github", value: false },
      { op: "setScopeRule", scopeId: "workspace", kind: "contexts", key: "x", patch: { enabled: false } },
    ]),
  );
  assert.equal(JSON.stringify(store.state), before);
});

test("setRuleForMode 只允许当前模式", () => {
  const { store } = tempStore();
  assert.equal(store.setRuleForMode("context-control", "sections", "free-search:engines", { enabled: false }).id, "context-control");
  assert.throws(() => store.setRuleForMode("full", "sections", "free-search:engines", { enabled: false }), /当前模式/);
});

test("transaction 串行且只提交一次", async () => {
  const { store } = tempStore();
  const before = store.revision;
  const results = await Promise.all(
    [1, 2, 3].map((n) =>
      store.transaction((draft) => {
        draft.brief = { enabled: n % 2 === 0 };
        return n;
      }),
    ),
  );
  assert.deepEqual(results, [1, 2, 3]);
  assert.equal(store.revision, before + 3);
  assert.equal(typeof sanitizeState(store.state).revision, "number");
});
