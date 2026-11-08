import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyCaps,
  buildCatalog,
  capPlan,
  discoverDiskSkills,
} from "../lib/capabilities.js";

test("没有目录段时，磁盘技能作为只读兜底列出", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-skills-"));
  try {
    const dir = join(root, ".dsh", "skills", "alpha");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: alpha-skill\ndescription: Alpha 的磁盘摘要\n---\n# Alpha\n");
    const found = discoverDiskSkills(root).find((entry) => entry.id === "alpha-skill");
    assert.ok(found);
    assert.equal(found.readOnly, true);
    assert.equal(found.source, "filesystem");
    assert.equal(found.summary, "Alpha 的磁盘摘要");
    assert.equal(found.tokens, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("有目录段时以目录段为准，忽略磁盘兜底", () => {
  const diskSkills = [{
    kind: "skills",
    key: "skill:disk-only",
    id: "disk-only",
    name: "disk-only",
    summary: "磁盘",
    tokens: 0,
    readOnly: true,
  }];
  const catalog = buildCatalog({
    sections: [{ name: "toolbox:catalog", text: "- skill:real — 目录里的技能", tokens: 12 }],
    diskSkills,
  });
  assert.deepEqual(catalog.skills.map((entry) => entry.id), ["real"]);
});

test("只读技能强制为 on，且不会生成删除规则", () => {
  const diskSkills = [{
    kind: "skills",
    key: "skill:disk-only",
    id: "disk-only",
    name: "disk-only",
    summary: "磁盘",
    tokens: 0,
    readOnly: true,
  }];
  const catalog = buildCatalog({ diskSkills });
  const applied = applyCaps(catalog, { "skill:disk-only": "hidden" });
  assert.equal(applied.skills[0].mode, "on");
  assert.equal(applied.skills[0].enabled, true);
  const plan = capPlan(catalog, { "skill:disk-only": "hidden" });
  assert.equal(plan.skills.size, 0);
  assert.equal(plan.items.length, 0);
});
