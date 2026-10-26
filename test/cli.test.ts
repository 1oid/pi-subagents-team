import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { extensionPath } from "../src/members.ts";
import { fixture } from "./helpers.ts";

for (const invocation of [
  { name: "/dev-lead", messages: ["/dev-lead", "修复 math.js 的加法并审查"], activate: false },
  { name: "自然语言激活", messages: ["使用 dev-team 进行 math.js 的加法修复和审查"], activate: true },
]) {
  test(`Pi CLI 完整验收：${invocation.name} 调查、修改、审查真实文件`, { timeout: 20000 }, async () => {
    const f = fixture();
    try {
      const configRoot = join(f.agentDir, "agents", "pi-subagents-team");
      mkdirSync(configRoot, { recursive: true });
      cpSync(fileURLToPath(new URL("../examples/dev-team", import.meta.url)), join(configRoot, "dev-team"), { recursive: true });
      writeFileSync(join(f.cwd, "math.js"), "export function add(a, b) { return a - b; }\n");
      const mock = join(f.agentDir, "mock-provider.ts");
      writeFileSync(mock, `
        import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
        export default function(pi) {
          pi.on("session_start", (_event, ctx) => { ctx.ui.notify = (message) => console.error(message); });
          const core = createFauxCore({ provider: "team-smoke", models: [{ id: "default" }], tokensPerSecond: Infinity });
          const respond = (context) => {
            const system = getCurrentSystemPrompt(context.messages);
            const messages = context.messages.filter((message) => message.role !== "system");
            const last = messages.at(-1);
            if (!system.includes("当前小队：") && getCurrentTools(context.messages).some((tool) => tool.name === "team_activate")) {
              return fauxAssistantMessage(fauxToolCall("team_activate", { team: "dev-team" }), { stopReason: "toolUse" });
            }
            if (system.includes("当前小队：")) {
              const count = messages.filter((message) => message.role === "toolResult" && message.toolName === "team_delegate").length;
              const tasks = [
                { member: "scout", task: "读取 math.js，调查 add 的实现" },
                { member: "worker", task: "修复 math.js 中的 add，使它执行加法" },
                { member: "reviewer", task: "读取 math.js，检查加法是否已修复" },
              ];
              if (count < tasks.length) return fauxAssistantMessage(fauxToolCall("team_delegate", { tasks: [tasks[count]] }), { stopReason: "toolUse" });
              return fauxAssistantMessage("CLI_TEAM_SMOKE_OK：调查、修改和审查完成");
            }
            if (last?.role === "toolResult") return fauxAssistantMessage("任务已完成：" + JSON.stringify(last.content));
            if (system.includes("你负责完成 leader 分配的代码修改和验证")) {
              return fauxAssistantMessage(fauxToolCall("write", { path: "math.js", content: "export function add(a, b) { return a + b; }\\n" }), { stopReason: "toolUse" });
            }
            return fauxAssistantMessage(fauxToolCall("read", { path: "math.js" }), { stopReason: "toolUse" });
          };
          core.setResponses(Array.from({ length: 20 }, () => respond));
          pi.registerProvider("team-smoke", {
            api: core.api, apiKey: "test-only-not-a-real-key", baseUrl: "http://unused.invalid",
            streamSimple: core.streamSimple,
            models: [{ id: "default", name: "Smoke", reasoning: false, input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
          });
        }
      `);
      writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({
        extensions: [mock, extensionPath], cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false },
      }));
      const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
      const execution = promisify(execFile)(process.execPath, [
        cli, "--no-session", "--mode", "json", "--model", "team-smoke/default", "-p", ...invocation.messages,
      ], { cwd: f.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir }, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      execution.child.stdin?.end();
      const { stdout, stderr } = await execution;
      assert.match(stdout, /CLI_TEAM_SMOKE_OK/, stderr || stdout);
      assert.doesNotMatch(stdout, /\(failed\)/);
      assert.equal(readFileSync(join(f.cwd, "math.js"), "utf8"), "export function add(a, b) { return a + b; }\n");
      assert.equal((await import(join(f.cwd, "math.js"))).add(2, 3), 5);
      const events = stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
      const members = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "team_delegate")
        .flatMap((event) => event.result.details.results.map((result: { member: string }) => result.member));
      assert.deepEqual(members, ["scout", "worker", "reviewer"]);
      assert.equal(events.filter((event) => event.type === "tool_execution_end" && event.toolName === "team_activate").length, invocation.activate ? 1 : 0);
    } finally { f.remove(); }
  });
}
