import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import { loadTeams, type Role, type Team } from "./src/config.ts";
import { addUsage, emptyUsage, extensionPath, TeamMembers, type MemberEnvironment } from "./src/members.ts";
import { installPolicy, selectedTools, validateResources } from "./src/policy.ts";
import { delegateRenderers, type TaskRow } from "./src/render.ts";

export default function teamExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const { teams, errors } = loadTeams(join(agentDir, "agents", "pi-subagents-team"));
  let active: {
    team: Team;
    role: Role;
    members: TeamMembers;
    env: MemberEnvironment;
    previousTools: string[];
  } | undefined;
  let changing = false;
  let registered = false;
  const available: Team[] = [];

  const getSkills = installPolicy(pi, () => active?.role, true);

  async function leave(ctx: ExtensionContext): Promise<void> {
    const previous = active;
    if (!previous) return;
    // 先保留策略直到当前任务已停止，避免成员尚未结束时放开 leader 的限制。
    ctx.abort();
    await previous.members.close();
    active = undefined;
    pi.setActiveTools(previous.previousTools);
    const restored = await pi.setModel(previous.env.model);
    pi.setThinkingLevel(previous.env.thinkingLevel);
    ctx.ui.setStatus("pi-subagents-team", undefined);
    if (!restored) ctx.ui.notify("原模型的认证不可用，未能恢复模型；请使用 /model 选择模型", "error");
  }

  async function activate(team: Team, ctx: ExtensionContext, skills: Skill[]): Promise<void> {
    if (changing) throw new Error("正在切换小队，请稍后重试");
    if (active?.team.id === team.id) return;
    changing = true;
    try {
      const baseModel = active?.env.model ?? ctx.model;
      if (!baseModel) throw new Error("请先用 /model 选择模型");
      const baseThinking = active?.env.thinkingLevel ?? pi.getThinkingLevel();
      const tools = pi.getAllTools();
      for (const role of [team.leader, ...team.members]) {
        validateResources(role, tools, skills);
        if (role.model) {
          const slash = role.model.indexOf("/");
          if (!ctx.modelRegistry.find(role.model.slice(0, slash), role.model.slice(slash + 1))) {
            throw new Error(`${role.name} 的模型不存在：${role.model}`);
          }
        }
      }
      const leaderModel = team.leader.model
        ? ctx.modelRegistry.find(team.leader.model.slice(0, team.leader.model.indexOf("/")), team.leader.model.slice(team.leader.model.indexOf("/") + 1))!
        : baseModel;
      if (!(await ctx.modelRegistry.getProviderAuth(leaderModel.provider))) throw new Error(`模型 ${leaderModel.provider}/${leaderModel.id} 未配置认证`);
      ctx.signal?.throwIfAborted();
      const previousTools = active?.previousTools ?? pi.getActiveTools();
      if (!(await pi.setModel(leaderModel))) throw new Error("无法启用 leader 模型，请检查认证");
      pi.setThinkingLevel(team.leader.thinkingLevel ?? baseThinking);
      await active?.members.close();
      const env: MemberEnvironment = {
        cwd: ctx.cwd, agentDir, model: baseModel, thinkingLevel: baseThinking,
        modelRegistry: ctx.modelRegistry, projectTrusted: ctx.isProjectTrusted(),
        extensionPaths: [...new Set([...tools, ...pi.getCommands().filter((command) => command.source === "extension")].map((resource) => resource.sourceInfo.path)
          .filter((path) => isAbsolute(path) && path !== extensionPath))],
      };
      const role: Role = { ...team.leader, promptText: `${team.leader.promptText}\n\n当前小队：${team.id}\n${team.description}\n\n成员职责：\n${team.members.map((member) => `- ${member.name}：${member.description}`).join("\n")}\n\n使用 team_delegate 分配具体任务；tasks 中的不同成员同时执行。成员保留本次小队模式内的上下文，可以再次交给同一成员继续处理。成员共享当前工作目录，请明确文件分工，不要同时安排修改同一文件。根据成员返回结果继续安排工作，最后由你回答用户。` };
      active = { team, role, members: new TeamMembers(team, env), env, previousTools };
      pi.setActiveTools(selectedTools(role, pi.getAllTools(), true));
      ctx.ui.setStatus("pi-subagents-team", `小队 ${team.id} · ${team.leader.name}`);
      ctx.ui.notify(`已进入 ${team.leader.name} 小队模式；/team 查看状态，/team exit 退出`, "info");
    } finally {
      changing = false;
    }
  }

  async function enter(team: Team, task: string, ctx: ExtensionCommandContext): Promise<void> {
    if (task.trim() && (ctx.mode === "print" || ctx.mode === "json")) {
      throw new Error(`Pi 非交互模式请分开传入命令和任务：pi -p "/${team.leader.name}" "任务"`);
    }
    if (!ctx.isIdle()) { ctx.ui.notify("请先停止当前任务，再调用小队命令", "warning"); return; }
    try {
      await activate(team, ctx, ctx.getSystemPromptOptions().skills ?? []);
      if (task.trim()) pi.sendUserMessage(task);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (registered) return;
    registered = true;
    for (const error of errors) ctx.ui.notify(error, "error");
    const commandNames = new Set(pi.getCommands().map((command) => command.name));
    if (commandNames.has("team") || pi.getAllTools().some((tool) => tool.name === "team_delegate" || tool.name === "team_activate")) {
      ctx.ui.notify("pi-subagents-team 未启用：team 命令或小队工具已被其他扩展占用", "error");
      return;
    }
    pi.registerTool({
      ...delegateRenderers,
      name: "team_delegate", label: "小队派工", exposure: "model-only", defaultActive: false,
      description: "给当前小队成员分配任务。不同成员并行执行，全部结束后返回各自结果。再次指定同一成员会保留它的上下文。",
      parameters: Type.Object({ tasks: Type.Array(Type.Object({
        member: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
      async execute(_id, { tasks }, signal, onUpdate) {
        if (!active) throw new Error("请先使用 /leader名 进入小队模式");
        let rows: TaskRow[] = tasks.map((task) => ({ ...task, status: "pending" }));
        const results = await active.members.delegate(tasks, signal, (progress) => {
          rows = rows.map((row) => row.member === progress.member ? { ...row, ...progress } : row);
          onUpdate?.({ content: [{ type: "text", text: `${progress.member}：${progress.activity || progress.status}` }], details: { tasks: rows } });
        });
        const usage = emptyUsage();
        for (const result of results) addUsage(usage, result.usage);
        return {
          content: [{ type: "text", text: results.map((result) => `## ${result.member} (${result.status})\n${result.output}`).join("\n\n") }],
          details: { tasks: rows, results }, usage,
        };
      },
    });
    for (const team of teams) {
      if (commandNames.has(team.leader.name)) {
        ctx.ui.notify(`/${team.leader.name} 已存在，未加载小队 ${team.id}`, "error");
        continue;
      }
      available.push(team);
      pi.registerCommand(team.leader.name, {
        description: `进入小队 ${team.id}：${team.description}`,
        handler: (task, context) => enter(team, task, context),
      });
    }
    pi.registerTool({
      name: "team_activate", label: "激活小队", exposure: "model-only", executionMode: "sequential",
      defaultActive: available.length > 0,
      description: "用户要求使用某个 team 或小队工作时，先调用本工具激活对应小队，再由 leader 使用 team_delegate 派工。"
        + "仅在用户要求使用或切换小队时调用；普通问答、查看配置、讨论小队名称不需要激活。"
        + "team 参数填写下列小队 ID，不要猜测不存在的名称。用户说的名称无法唯一对应时先询问。"
        + "重复激活当前小队会保留成员上下文；切换小队会结束旧成员会话。激活后继续处理当前用户任务，不要重复发送用户消息。\n"
        + available.map((team) => `- ${team.id}（leader: ${team.leader.name}）：${team.description}`).join("\n"),
      parameters: Type.Object({ team: Type.String({ minLength: 1, description: "要激活的小队 ID，即配置目录名" }) }, { additionalProperties: false }),
      async execute(_id, { team: id }, signal, _onUpdate, ctx) {
        const team = available.find((team) => team.id === id);
        if (!team) throw new Error(`找不到可用小队：${id}。可用小队：${available.map((team) => team.id).join(", ") || "无"}`);
        signal?.throwIfAborted();
        await activate(team, ctx, getSkills());
        return {
          content: [{ type: "text", text: `已激活小队 ${team.id}，当前 leader 为 ${team.leader.name}。继续处理用户当前任务，按需使用 team_delegate 派工。` }],
          details: { team: team.id, leader: team.leader.name },
        };
      },
    });
    pi.registerCommand("team", {
      description: "查看小队和成员状态；/team exit 退出小队",
      async handler(args, context) {
        if (args.trim() === "exit") {
          if (changing) { context.ui.notify("正在切换小队，请稍后重试", "warning"); return; }
          changing = true;
          try {
            await leave(context);
            await context.waitForIdle();
            context.ui.notify("已退出小队模式", "info");
          } finally { changing = false; }
          return;
        }
        if (args.trim()) { context.ui.notify("用法：/team 或 /team exit", "warning"); return; }
        const lines = available.map((team) => `${team.id}（/${team.leader.name}）— ${team.description}`);
        if (!lines.length) lines.push(`没有可用小队。请在 ${join(agentDir, "agents", "pi-subagents-team")} 下添加配置，再 /reload。`);
        if (active) lines.push(`\n当前 leader：${active.team.leader.name}`, ...[...active.members.states].map(([name, state]) => `${name}：${state.status}`));
        pi.sendMessage({ customType: "team-status", content: lines.join("\n"), display: true, details: undefined });
      },
    });
  });
  pi.on("session_shutdown", (_event, ctx) => leave(ctx));
}
