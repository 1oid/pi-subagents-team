import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadTeams } from "../src/config.ts";
import { fixture, writeTeam } from "./helpers.ts";

test("加载多队、提示词和三种白名单配置", () => {
  const f = fixture();
  try {
    writeTeam(f.agentDir, "alpha", { tools: [], skills: ["typescript"], model: "test/model", thinkingLevel: "high" });
    writeTeam(f.agentDir, "beta");
    const result = loadTeams(join(f.agentDir, "agents/pi-subagents-team"));
    assert.deepEqual(result.errors, []);
    assert.equal(result.teams.length, 2);
    assert.deepEqual(result.teams[0].leader.tools, []);
    assert.deepEqual(result.teams[0].leader.skills, ["typescript"]);
    assert.equal(result.teams[1].leader.tools, undefined);
    assert.equal(result.teams[0].leader.promptText, "你是测试 leader");
    assert.equal(result.teams[0].leader.model, "test/model");
  } finally { f.remove(); }
});

test("错误配置不会挡住有效小队；重复 leader 均被拒绝", () => {
  const f = fixture();
  try {
    writeTeam(f.agentDir, "valid");
    writeTeam(f.agentDir, "dup-a", { name: "same" });
    writeTeam(f.agentDir, "dup-b", { name: "same" });
    writeTeam(f.agentDir, "reserved", { name: "model" });
    writeTeam(f.agentDir, "modifier", { tools: ["+read"] });
    writeTeam(f.agentDir, "wildcard", { tools: ["*"] });
    writeTeam(f.agentDir, "unknown", { typo: true });
    const missing = writeTeam(f.agentDir, "missing");
    rmSync(join(missing, "member.md"));
    writeTeam(f.agentDir, "duplicate-member", {}, [
      { name: "worker", description: "one", prompt: "member.md" },
      { name: "worker", description: "two", prompt: "member.md" },
    ]);
    const yaml = writeTeam(f.agentDir, "yaml");
    writeFileSync(join(yaml, "team.yaml"), "leader: a\nleader: b\n");
    const result = loadTeams(join(f.agentDir, "agents/pi-subagents-team"));
    assert.deepEqual(result.teams.map((team) => team.id), ["valid"]);
    assert.equal(result.errors.length, 8);
    assert.match(result.errors.join("\n"), /leader 名称重复/);
    assert.match(result.errors.join("\n"), /成员名称重复/);
  } finally { f.remove(); }
});

test("目录不存在时返回空列表", () => {
  assert.deepEqual(loadTeams("/nonexistent/pi-team-test"), { teams: [], errors: [] });
});
