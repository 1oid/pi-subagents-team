import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { Member, Team } from "./config.ts";
import { installPolicy, selectedTools, validateResources } from "./policy.ts";

export const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

export interface MemberEnvironment {
  cwd: string;
  agentDir: string;
  model: NonNullable<ExtensionContext["model"]>;
  thinkingLevel: NonNullable<ExtensionContext["thinkingLevel"]>;
  modelRegistry: ExtensionContext["modelRegistry"];
  projectTrusted: boolean;
  extensionPaths: string[];
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function addUsage(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
}

export async function disposeMember(session: AgentSession): Promise<void> {
  try {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}

export async function createMemberSession(member: Member, env: MemberEnvironment): Promise<AgentSession> {
  const settings = SettingsManager.create(env.cwd, env.agentDir, { projectTrusted: env.projectTrusted });
  // 成员没有后台生命周期；空闲时不发预热请求，也不把这些设置写回磁盘。
  settings.applyOverrides({ cacheWarming: "off" });
  const runtime = await ModelRuntime.create({
    authPath: join(env.agentDir, "auth.json"), modelsPath: join(env.agentDir, "models.json"),
  });
  for (const provider of env.modelRegistry.getRegisteredProviderIds()) {
    const native = env.modelRegistry.getRegisteredNativeProvider(provider);
    const config = env.modelRegistry.getRegisteredProviderConfig(provider);
    if (native) runtime.registerNativeProvider(native);
    else if (config) runtime.registerProvider(provider, config);
  }
  const loader = new DefaultResourceLoader({
    cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings,
    noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: env.extensionPaths.filter((path) => resolve(path) !== extensionPath),
    extensionFactories: [
      { name: "codemode", builtin: true, factory: createCodemodeExtension() },
      { name: "tool_search", builtin: true, factory: createToolSearchExtension() },
      { name: "mcp", builtin: true, factory: createMcpExtension() },
      { name: "team-member-policy", factory: (pi) => { installPolicy(pi, () => member, false); } },
    ],
    extensionsOverride: (loaded) => ({
      ...loaded,
      extensions: loaded.extensions.filter((extension) => resolve(extension.resolvedPath) !== extensionPath),
    }),
    skillsOverride: (base) => ({ ...base,
      skills: member.skills === undefined ? base.skills : base.skills.filter((skill) => member.skills!.includes(skill.name)),
    }),
  });
  await loader.reload();
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length) throw new Error(loadErrors.map((error) => `${error.path}: ${error.error}`).join("\n"));
  const model = member.model
    ? env.modelRegistry.find(member.model.slice(0, member.model.indexOf("/")), member.model.slice(member.model.indexOf("/") + 1))
    : env.model;
  if (!model) throw new Error(`${member.name} 的模型不存在：${member.model}`);
  const { session } = await createAgentSession({
    cwd: env.cwd, agentDir: env.agentDir, modelRuntime: runtime, model,
    thinkingLevel: member.thinkingLevel ?? env.thinkingLevel,
    resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(env.cwd),
    tools: member.tools ?? ["*"],
  });
  try {
    const startupErrors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => startupErrors.push(`${error.extensionPath}: ${error.error}`) });
    if (startupErrors.length) throw new Error(startupErrors.join("\n"));
    validateResources(member, session.getAllTools(), loader.getSkills().skills);
    session.setActiveToolsByName(selectedTools(member, session.getAllTools(), false));
    return session;
  } catch (error) {
    await disposeMember(session);
    throw error;
  }
}

export interface Task { member: string; task: string }
export interface MemberResult {
  member: string;
  status: "completed" | "failed" | "cancelled";
  output: string;
  usage: Usage;
}
export interface MemberProgress {
  member: string;
  status: "running" | MemberResult["status"];
  activity: string;
}
type MemberState = {
  role: Member;
  session?: AgentSession;
  status: "idle" | "running" | MemberResult["status"];
};

export class TeamMembers {
  readonly states: Map<string, MemberState>;
  private readonly env: MemberEnvironment;
  private readonly factory: typeof createMemberSession;
  private readonly cancel = new AbortController();
  private readonly pending = new Set<Promise<MemberResult>>();
  private closing?: Promise<void>;

  constructor(team: Team, env: MemberEnvironment, factory = createMemberSession) {
    this.states = new Map(team.members.map((role) => [role.name, { role, status: "idle" }]));
    this.env = env;
    this.factory = factory;
  }

  async delegate(tasks: Task[], signal?: AbortSignal, onProgress?: (progress: MemberProgress) => void): Promise<MemberResult[]> {
    if (this.cancel.signal.aborted) throw new Error("小队已经结束");
    if (!tasks.length) throw new Error("至少指定一个任务");
    const seen = new Set<string>();
    for (const task of tasks) {
      const state = this.states.get(task.member);
      if (!state) throw new Error(`当前小队没有成员：${task.member}`);
      if (seen.has(task.member)) throw new Error(`同一批任务重复指定了成员：${task.member}`);
      if (state.status === "running") throw new Error(`成员 ${task.member} 正在执行任务，请等待结果`);
      if (!task.task.trim()) throw new Error(`${task.member} 的任务不能为空`);
      seen.add(task.member);
    }
    const combined = AbortSignal.any([this.cancel.signal, ...(signal ? [signal] : [])]);
    const jobs = tasks.map((task) => {
      const state = this.states.get(task.member)!;
      state.status = "running";
      const job = this.run(state, task.task, combined, onProgress);
      this.pending.add(job);
      void job.finally(() => this.pending.delete(job));
      return job;
    });
    return Promise.all(jobs);
  }

  private async run(state: MemberState, task: string, signal: AbortSignal, onProgress?: (progress: MemberProgress) => void): Promise<MemberResult> {
    const result: MemberResult = { member: state.role.name, status: "failed", output: "", usage: emptyUsage() };
    let unsubscribe: (() => void) | undefined;
    const abort = () => { void state.session?.abort(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      onProgress?.({ member: state.role.name, status: "running", activity: "启动中" });
      state.session ??= await this.factory(state.role, this.env);
      signal.throwIfAborted();
      const session = state.session;
      onProgress?.({ member: state.role.name, status: "running", activity: "思考中" });
      unsubscribe = session.subscribe((event) => {
        if (event.type === "tool_execution_start") onProgress?.({ member: state.role.name, status: "running", activity: `执行 ${event.toolName}` });
        if (event.type === "turn_start") onProgress?.({ member: state.role.name, status: "running", activity: "思考中" });
        if (event.type === "message_end" && event.message.role === "assistant") addUsage(result.usage, event.message.usage);
      });
      const previousLength = session.messages.length;
      await session.prompt(task, { expandPromptTemplates: false });
      const last = session.messages.slice(previousLength).findLast((message) => message.role === "assistant");
      result.output = last?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
      if (last?.stopReason === "error") throw new Error(last.errorMessage || "模型请求失败");
      if (signal.aborted || last?.stopReason === "aborted") result.status = "cancelled";
      else if (!last) throw new Error("成员没有产生回答");
      else result.status = "completed";
    } catch (error) {
      result.status = signal.aborted ? "cancelled" : "failed";
      result.output = error instanceof Error ? error.message : String(error);
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe?.();
      state.status = result.status;
    }
    onProgress?.({ member: state.role.name, status: result.status, activity: "" });
    return result;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.cancel.abort();
      await Promise.allSettled([...this.pending]);
      await Promise.all([...this.states.values()].map(async (state) => {
        if (state.session) await disposeMember(state.session);
        state.session = undefined;
      }));
    })();
    return this.closing;
  }
}
