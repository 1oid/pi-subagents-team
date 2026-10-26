import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { harness, writeTeam } from "./helpers.ts";

test("自然语言激活后在同一回答中应用 leader 模型、角色和白名单并派工", async () => {
  const calls: Array<{ model: string; prompt: string; tools: string[] }> = [];
  const h = await harness({ extension: true,
    configure: ({ agentDir }) => {
      writeTeam(agentDir, "dev-team", { tools: ["read"], skills: ["allowed-skill"], model: "team-test/special", thinkingLevel: "high" },
        [{ name: "worker", description: "实现", prompt: "member.md", tools: [], skills: [] }]);
      for (const name of ["allowed-skill", "other-skill"]) {
        const dir = join(agentDir, "skills", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n说明`);
      }
    },
    respond: (context, _options, _state, model) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      const tools = getCurrentTools(context.messages);
      calls.push({ model: model.id, prompt, tools: tools.map((tool) => tool.name) });
      if (prompt.includes("你是测试成员")) return fauxAssistantMessage("成员已完成");
      const last = context.messages.at(-1);
      if (last?.role === "user") {
        const activation = tools.find((tool) => tool.name === "team_activate");
        assert.match(activation!.description, /dev-team.*dev-team-lead/);
        return fauxAssistantMessage(fauxToolCall("team_activate", { team: "dev-team" }), { stopReason: "toolUse" });
      }
      if (last?.role === "toolResult" && last.toolName === "team_activate") {
        return fauxAssistantMessage(fauxToolCall("team_delegate", { tasks: [{ member: "worker", task: "实现用户要求" }] }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("leader 已汇总");
    },
  });
  try {
    const baseline = h.session.getActiveToolNames();
    assert.ok(baseline.includes("team_activate"));
    assert.ok(!baseline.includes("team_delegate"));
    await h.session.prompt("使用 dev-team 进行实现工作");
    assert.equal(h.session.getLastAssistantText(), "leader 已汇总");
    assert.equal(calls[0].model, "default");
    assert.match(calls[0].prompt, /other-skill/);
    assert.equal(calls[1].model, "special");
    assert.match(calls[1].prompt, /当前小队：dev-team/);
    assert.match(calls[1].prompt, /allowed-skill/);
    assert.doesNotMatch(calls[1].prompt, /other-skill/);
    assert.deepEqual(calls[1].tools.sort(), ["read", "team_activate", "team_delegate"]);
    assert.deepEqual(calls[2].tools, []);
    assert.equal(calls[2].model, "default");
    assert.equal(h.session.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(h.session.thinkingLevel, "high");
    await h.session.prompt("/team exit");
    assert.equal(h.session.model!.id, "default");
    assert.equal(h.session.thinkingLevel, "off");
    assert.deepEqual(h.session.getActiveToolNames(), baseline);
    assert.deepEqual(h.extensionErrors, []);
  } finally { await h.close(); }
});

test("重复激活保留成员上下文；自然语言切队释放旧会话且恢复技能目录", async () => {
  const leaderPrompts: string[] = [];
  const h = await harness({ extension: true,
    configure: ({ agentDir }) => {
      writeTeam(agentDir, "one", { tools: ["read"], skills: [] });
      writeTeam(agentDir, "two", { tools: ["read"] });
      const dir = join(agentDir, "skills", "test-skill");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: test-skill\ndescription: test\n---\n说明");
    },
    respond: (context) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      if (prompt.includes("你是测试成员")) {
        return fauxAssistantMessage(`history:${context.messages.filter((message) => message.role === "user").length}`);
      }
      const last = context.messages.at(-1);
      if (last?.role === "user") {
        const text = typeof last.content === "string" ? last.content : last.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        return fauxAssistantMessage(fauxToolCall("team_activate", { team: text.includes("two") ? "two" : "one" }), { stopReason: "toolUse" });
      }
      if (last?.role === "toolResult" && last.toolName === "team_activate") {
        leaderPrompts.push(prompt);
        return fauxAssistantMessage(fauxToolCall("team_delegate", { tasks: [{ member: "worker", task: "继续工作" }] }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("完成");
    },
  });
  try {
    for (const id of ["one", "one", "two", "one"]) await h.session.prompt(`使用 ${id} team 工作`);
    const results = h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === "team_delegate");
    assert.deepEqual(results.map((result) => JSON.stringify(result).match(/history:(\d+)/)?.[1]), ["1", "2", "1", "1"]);
    assert.doesNotMatch(leaderPrompts[0], /test-skill/);
    assert.match(leaderPrompts[2], /test-skill/);
    assert.match(leaderPrompts[2], /当前小队：two/);
    assert.doesNotMatch(leaderPrompts[2], /当前小队：one/);
    assert.doesNotMatch(leaderPrompts[3], /test-skill/);
    assert.deepEqual(h.extensionErrors, []);
  } finally { await h.close(); }
});

test("未知小队和无效白名单返回工具错误，不影响当前小队", async () => {
  const h = await harness({ extension: true,
    configure: ({ agentDir }) => {
      writeTeam(agentDir, "valid", { tools: [], skills: [] });
      writeTeam(agentDir, "invalid", { skills: ["missing-skill"] });
    },
    respond: (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") return fauxAssistantMessage(JSON.stringify(last));
      const input = JSON.stringify(last);
      return fauxAssistantMessage(fauxToolCall("team_activate", { team: input.includes("invalid") ? "invalid" : "missing" }), { stopReason: "toolUse" });
    },
  });
  try {
    await h.session.prompt("/valid-lead");
    const before = h.session.getActiveToolNames();
    for (const target of ["missing", "invalid"]) {
      await h.session.prompt(`使用 ${target} 小队工作`);
      const result = h.session.messages.findLast((message) => message.role === "toolResult");
      assert.ok(result?.isError);
      assert.match(JSON.stringify(result), target === "missing" ? /找不到可用小队/ : /找不到 skill/);
      assert.deepEqual(h.session.getActiveToolNames(), before);
    }
    assert.equal(h.statuses.at(-1), "小队 valid · valid-lead");
    assert.deepEqual(h.extensionErrors, []);
  } finally { await h.close(); }
});

test("普通对话不自动切队；没有有效配置时不启用激活工具", async () => {
  const normal = await harness({ extension: true, configure: ({ agentDir }) => { writeTeam(agentDir, "dev"); } });
  try {
    await normal.session.prompt("解释一下什么是 team");
    assert.equal(normal.statuses.length, 0);
    assert.ok(normal.session.getActiveToolNames().includes("team_activate"));
    assert.ok(!normal.session.getActiveToolNames().includes("team_delegate"));
  } finally { await normal.close(); }
  const empty = await harness({ extension: true });
  try { assert.ok(!empty.session.getActiveToolNames().includes("team_activate")); }
  finally { await empty.close(); }
});
