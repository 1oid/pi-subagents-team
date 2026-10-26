import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { createMemberSession, TeamMembers } from "../src/members.ts";
import type { Member, Team } from "../src/config.ts";
import { harness, writeTeam } from "./helpers.ts";

const member = (name: string, extra: Partial<Member> = {}): Member => ({ name, description: name, prompt: "member.md", promptText: `role:${name}`, tools: [], skills: [], ...extra });
const team = (...members: Member[]): Team => ({ id: "test", description: "测试", leader: member("lead"), members });
const userTexts = (context: TranscriptContext) => context.messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));

test("真实 SDK 成员：并行执行、保留各自上下文、累计用量", { timeout: 20000 }, async () => {
  const contexts: string[][] = [];
  let arrivals = 0;
  const barrier = Promise.withResolvers<void>();
  const h = await harness({ respond: async (context) => {
    contexts.push(userTexts(context));
    if (++arrivals <= 2) {
      if (arrivals === 2) barrier.resolve();
      await barrier.promise;
    }
    return fauxAssistantMessage(`seen:${userTexts(context).join("|")}`);
  } });
  const squad = new TeamMembers(team(member("one"), member("two")), h.env);
  try {
    const results = await squad.delegate([{ member: "one", task: "one-secret" }, { member: "two", task: "two-secret" }]);
    assert.deepEqual(results.map((result) => result.status), ["completed", "completed"]);
    assert.equal(arrivals, 2);
    const next = await squad.delegate([{ member: "one", task: "follow-up" }]);
    assert.match(next[0].output, /one-secret.*follow-up/);
    assert.doesNotMatch(next[0].output, /two-secret/);
    assert.ok(next[0].usage.totalTokens > 0);
    assert.equal(squad.states.get("one")!.session!.messages.filter((message) => message.role === "user").length, 2);
  } finally { await squad.close(); await h.close(); }
});

test("真实 SDK 白名单：模型可见工具、间接调用、技能和扩展实例", { timeout: 20000 }, async () => {
  const snapshots: Array<{ tools: string[]; prompt: string }> = [];
  const h = await harness({
    configure: ({ agentDir }) => {
      for (const name of ["allowed-skill", "other-skill"]) {
        mkdirSync(join(agentDir, "skills", name), { recursive: true });
        writeFileSync(join(agentDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} instructions\n---\n${name} content`);
      }
      mkdirSync(join(agentDir, "extensions"));
      writeFileSync(join(agentDir, "extensions", "test.ts"), `
        import { Type } from "typebox";
        export default function (pi) {
          let count = 0;
          pi.registerTool({ name: "counter", exposure: "codemode", label: "counter", description: "counter", parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: String(++count) }], details: undefined }) });
          pi.registerTool({ name: "bridge", label: "bridge", description: "bridge", parameters: Type.Object({}),
            execute: async (_id, _args, _signal, _update, ctx) => {
              const result = await ctx.executeTool("counter", {});
              return { content: result.content, details: undefined };
            } });
        }
      `);
    },
    respond: (context) => {
      snapshots.push({ tools: getCurrentTools(context.messages).map((tool) => tool.name), prompt: getCurrentSystemPrompt(context.messages) });
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") return fauxAssistantMessage(JSON.stringify(last));
      const text = userTexts(context).at(-1);
      if (text === "bridge") return fauxAssistantMessage(fauxToolCall("bridge", {}), { stopReason: "toolUse" });
      if (text === "counter") return fauxAssistantMessage(fauxToolCall("counter", {}), { stopReason: "toolUse" });
      return fauxAssistantMessage("ok");
    },
  });
  const children = [];
  try {
    const limited = await createMemberSession(member("limited", { tools: ["read", "bridge"], skills: ["allowed-skill"] }), h.env);
    children.push(limited);
    await limited.prompt("bridge");
    assert.match(limited.getLastAssistantText()!, /未获准使用工具.*counter|Tool counter not found/);
    assert.deepEqual(snapshots[0].tools.sort(), ["bridge", "read"]);
    assert.match(snapshots[0].prompt, /allowed-skill/);
    assert.doesNotMatch(snapshots[0].prompt, /other-skill/);
    const before = limited.messages.length;
    await limited.prompt("/skill:other-skill");
    assert.equal(limited.messages.length, before);
    const empty = await createMemberSession(member("empty"), h.env);
    children.push(empty);
    await empty.prompt("hello");
    assert.deepEqual(snapshots.at(-1)!.tools, []);
    assert.doesNotMatch(snapshots.at(-1)!.prompt, /allowed-skill|other-skill/);
    const all = await createMemberSession(member("all", { tools: undefined, skills: undefined }), h.env);
    const another = await createMemberSession(member("another", { tools: ["counter"] }), h.env);
    children.push(all, another);
    await all.prompt("counter");
    await another.prompt("counter");
    assert.match(all.getLastAssistantText()!, /\\"text\\":\\"1\\"|"text":"1"/);
    assert.match(another.getLastAssistantText()!, /\\"text\\":\\"1\\"|"text":"1"/);
    assert.ok(all.getActiveToolNames().includes("write"));
    assert.ok(all.resourceLoader.getSkills().skills.some((skill) => skill.name === "other-skill"));
    await assert.rejects(createMemberSession(member("bad", { tools: ["missing-tool"] }), h.env), /找不到工具/);
    await assert.rejects(createMemberSession(member("bad", { skills: ["missing-skill"] }), h.env), /找不到 skill/);
  } finally { await h.close(children); }
});

test("部分失败、未知成员、重复任务及忙碌冲突", { timeout: 20000 }, async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const h = await harness({ respond: async (context) => {
    if (userTexts(context).at(-1) === "wait") { started.resolve(); await release.promise; }
    return fauxAssistantMessage("完成");
  } });
  const squad = new TeamMembers(team(member("ok"), member("bad", { model: "unknown/model" })), h.env);
  try {
    await assert.rejects(squad.delegate([{ member: "missing", task: "x" }]), /没有成员/);
    await assert.rejects(squad.delegate([{ member: "ok", task: "x" }, { member: "ok", task: "y" }]), /重复/);
    const pending = squad.delegate([{ member: "ok", task: "wait" }]);
    await started.promise;
    await assert.rejects(squad.delegate([{ member: "ok", task: "again" }]), /正在执行/);
    release.resolve();
    await pending;
    const results = await squad.delegate([{ member: "ok", task: "x" }, { member: "bad", task: "x" }]);
    assert.deepEqual(results.map((result) => result.status), ["completed", "failed"]);
    assert.match(results[1].output, /模型不存在/);
  } finally { release.resolve(); await squad.close(); await h.close(); }
});

test("取消传递给真实 SDK 成员；关闭后不能派工", { timeout: 20000 }, async () => {
  const started = Promise.withResolvers<void>();
  const h = await harness({ respond: async (_context, options) => {
    started.resolve();
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
  } });
  const squad = new TeamMembers(team(member("worker")), h.env);
  try {
    const abort = new AbortController();
    const result = squad.delegate([{ member: "worker", task: "wait" }], abort.signal);
    await started.promise;
    abort.abort();
    assert.equal((await result)[0].status, "cancelled");
    await squad.close();
    assert.equal(squad.states.get("worker")!.session, undefined);
    await assert.rejects(squad.delegate([{ member: "worker", task: "x" }]), /已经结束/);
  } finally { await squad.close(); await h.close(); }
});

test("真实扩展命令：leader 模式、空白名单派工、追问、退出及设置恢复", { timeout: 30000 }, async () => {
  const h = await harness({ extension: true,
    configure: ({ agentDir }) => { writeTeam(agentDir, "dev", { tools: [], skills: [], model: "team-test/special", thinkingLevel: "high" }); },
    respond: (context) => {
      const prompt = getCurrentSystemPrompt(context.messages);
      if (!prompt.includes("当前小队")) return fauxAssistantMessage(`worker:${userTexts(context).join("|")}`);
      if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("leader 已汇总");
      return fauxAssistantMessage(fauxToolCall("team_delegate", { tasks: [{ member: "worker", task: userTexts(context).at(-1)! }] }), { stopReason: "toolUse" });
    },
  });
  try {
    const before = h.session.getActiveToolNames();
    assert.ok(h.session.extensionRunner.getCommand("dev-lead"));
    await h.session.prompt("/dev-lead");
    assert.ok(h.notices.some((message) => message.includes("已进入")), h.notices.join("\n"));
    assert.deepEqual(h.session.getActiveToolNames(), ["team_activate", "team_delegate"]);
    assert.equal(h.session.model!.id, "special");
    await h.session.prompt("first task");
    await h.session.prompt("follow-up");
    const delegationResults = h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === "team_delegate");
    assert.equal(delegationResults.length, 2);
    assert.match(JSON.stringify(delegationResults[1]), /first task.*follow-up/);
    await h.session.prompt("/team");
    await h.session.prompt("/team exit");
    assert.deepEqual(h.session.getActiveToolNames(), before);
    assert.equal(h.session.model!.id, "default");
    assert.equal(h.session.thinkingLevel, "off");
    assert.equal(h.statuses.at(-1), undefined);
    await h.session.prompt("normal");
    assert.doesNotMatch(h.session.systemPrompt, /当前小队/);
    assert.deepEqual(h.extensionErrors, []);
  } finally { await h.close(); }
});

test("命令冲突不会覆盖已有命令，坏资源不进入小队", { timeout: 15000 }, async () => {
  const h = await harness({ extension: true,
    configure: ({ agentDir }) => {
      writeTeam(agentDir, "collision");
      writeTeam(agentDir, "bad", { tools: ["nonexistent"] });
    },
    factories: [(pi) => { pi.registerCommand("collision-lead", { handler: async () => {} }); }],
  });
  try {
    assert.ok(h.notices.some((message) => message.includes("/collision-lead 已存在")));
    assert.ok(h.session.extensionRunner.getCommand("collision-lead"));
    const before = h.session.getActiveToolNames();
    await h.session.prompt("/bad-lead");
    assert.deepEqual(h.session.getActiveToolNames(), before);
    assert.ok(h.notices.some((message) => message.includes("找不到工具 nonexistent")));
    assert.deepEqual(h.extensionErrors, []);
  } finally { await h.close(); }
});
