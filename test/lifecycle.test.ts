import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createMemberSession, TeamMembers } from "../src/members.ts";
import type { Member, Team } from "../src/config.ts";
import { harness, writeTeam } from "./helpers.ts";

test("成员模型分别配置，省略时继承进入小队前的设置", async () => {
  const h = await harness();
  const base: Member = { name: "default", prompt: "unused", promptText: "test", description: "test", tools: [], skills: [] };
  const team: Team = { id: "test", description: "test", leader: base,
    members: [base, { ...base, name: "special", model: "team-test/special", thinkingLevel: "high" }] };
  const squad = new TeamMembers(team, h.env);
  try {
    const results = await squad.delegate([{ member: "default", task: "one" }, { member: "special", task: "two" }]);
    assert.deepEqual(results.map((result) => result.status), ["completed", "completed"]);
    assert.equal(squad.states.get("default")!.session!.model!.id, "default");
    assert.equal(squad.states.get("default")!.session!.thinkingLevel, "off");
    assert.equal(squad.states.get("special")!.session!.model!.id, "special");
    assert.equal(squad.states.get("special")!.session!.thinkingLevel, "high");
  } finally { await squad.close(); await h.close(); }
});

test("leader 间接工具调用也受白名单限制，工具激活不能扩大范围", async () => {
  let blockedCalls = 0;
  const seenTools: string[][] = [];
  const h = await harness({ extension: true,
    configure: ({ agentDir }) => { writeTeam(agentDir, "limited", { tools: ["bridge"], skills: [] }); },
    factories: [(pi) => {
      pi.registerTool({ name: "forbidden", label: "forbidden", description: "forbidden", exposure: "codemode", parameters: Type.Object({}),
        execute: async () => { blockedCalls++; return { content: [{ type: "text", text: "should never run" }], details: undefined }; } });
      pi.registerTool({ name: "bridge", label: "bridge", description: "bridge", parameters: Type.Object({}),
        execute: async (_id, _args, _signal, _update, ctx) => {
          pi.setActiveTools([...pi.getActiveTools(), "forbidden"]);
          const result = await ctx.executeTool("forbidden", {});
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
        } });
    }],
    respond: (context) => {
      seenTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
      const last = context.messages.at(-1);
      return last?.role === "toolResult"
        ? fauxAssistantMessage(JSON.stringify(last))
        : fauxAssistantMessage(fauxToolCall("bridge", {}), { stopReason: "toolUse" });
    },
  });
  try {
    await h.session.prompt("/limited-lead");
    await h.session.prompt("test nested tools");
    assert.equal(blockedCalls, 0);
    assert.match(h.session.getLastAssistantText()!, /未获准使用工具.*forbidden/);
    assert.ok(seenTools.every((tools) => !tools.includes("forbidden")));
    await h.session.prompt("/skill:anything");
    assert.ok(h.notices.some((message) => message.includes("未获准使用 skill")));
    assert.deepEqual(h.extensionErrors, []);
  } finally { await h.close(); }
});

test("命令自带任务、切换小队、重新进入和 reload 均正确释放成员", { timeout: 20000 }, async () => {
  let lifecycleFile = "";
  const h = await harness({ extension: true,
    configure: ({ agentDir, root }) => {
      writeTeam(agentDir, "one", { tools: [], skills: [] });
      writeTeam(agentDir, "two", { tools: [], skills: [] });
      lifecycleFile = join(root, "lifecycle.jsonl");
      mkdirSync(join(agentDir, "extensions"));
      writeFileSync(join(agentDir, "extensions", "lifecycle.ts"), `
        import { appendFileSync } from "node:fs";
        export default function(pi) {
          pi.on("session_shutdown", (_event, ctx) => appendFileSync(${JSON.stringify(lifecycleFile)}, JSON.stringify({ id: ctx.sessionManager.getSessionId() }) + "\\n"));
        }
      `);
    },
    respond: (context) => {
      const userMessages = context.messages.filter((message) => message.role === "user");
      if (!getCurrentSystemPrompt(context.messages).includes("当前小队")) return fauxAssistantMessage(`history:${userMessages.length}`);
      if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("汇总完成");
      return fauxAssistantMessage(fauxToolCall("team_delegate", { tasks: [{ member: "worker", task: "work" }] }), { stopReason: "toolUse" });
    },
  });
  const results = () => h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === "team_delegate");
  try {
    const baseline = h.session.getActiveToolNames();
    await h.session.prompt("/one-lead initial");
    await h.session.waitForIdle();
    assert.match(JSON.stringify(results().at(-1)), /history:1/);
    await h.session.prompt("/one-lead again");
    await h.session.waitForIdle();
    assert.match(JSON.stringify(results().at(-1)), /history:2/);
    await h.session.prompt("/two-lead next");
    await h.session.waitForIdle();
    assert.match(JSON.stringify(results().at(-1)), /history:1/);
    assert.equal(readFileSync(lifecycleFile, "utf8").trim().split("\n").length, 1);
    await h.session.prompt("/one-lead fresh");
    await h.session.waitForIdle();
    assert.match(JSON.stringify(results().at(-1)), /history:1/);
    await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    assert.deepEqual(h.session.getActiveToolNames(), baseline);
    assert.equal(readFileSync(lifecycleFile, "utf8").trim().split("\n").length, 4); // 三个成员和宿主。
    assert.deepEqual(h.extensionErrors, []);
  } finally { await h.close(); }
});

test("运行中 /team exit 会停止成员并恢复普通模式", { timeout: 15000 }, async () => {
  const started = Promise.withResolvers<void>();
  const h = await harness({ extension: true,
    configure: ({ agentDir }) => { writeTeam(agentDir, "dev", { tools: [], skills: [] }); },
    respond: async (context, options) => {
      if (getCurrentSystemPrompt(context.messages).includes("当前小队")) {
        return fauxAssistantMessage(fauxToolCall("team_delegate", { tasks: [{ member: "worker", task: "wait" }] }), { stopReason: "toolUse" });
      }
      started.resolve();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
    },
  });
  try {
    const baseline = h.session.getActiveToolNames();
    await h.session.prompt("/dev-lead");
    const pending = h.session.prompt("start");
    await started.promise;
    await h.session.prompt("/team exit");
    await pending;
    assert.deepEqual(h.session.getActiveToolNames(), baseline);
    assert.equal(h.session.isIdle, true);
    assert.ok(h.notices.includes("已退出小队模式"));
    assert.deepEqual(h.extensionErrors, []);
  } finally { await h.close(); }
});
