import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { disposeMember, extensionPath, type MemberEnvironment } from "../src/members.ts";

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-team-test-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir); mkdirSync(cwd);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } }));
  return { root, agentDir, cwd, remove: () => rmSync(root, { recursive: true, force: true }) };
}

export function writeTeam(agentDir: string, id: string, leader: Record<string, unknown> = {}, members?: Record<string, unknown>[]) {
  const dir = join(agentDir, "agents", "pi-subagents-team", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "leader.md"), "你是测试 leader");
  writeFileSync(join(dir, "member.md"), "你是测试成员");
  writeFileSync(join(dir, "team.yaml"), stringify({
    description: "测试小队",
    leader: { name: `${id}-lead`, prompt: "leader.md", ...leader },
    members: members ?? [{ name: "worker", description: "完成任务", prompt: "member.md" }],
  }));
  return dir;
}

export async function harness(options: {
  extension?: boolean;
  configure?: (files: ReturnType<typeof fixture>) => void;
  respond?: FauxResponseFactory;
  factories?: ExtensionFactory[];
} = {}) {
  const files = fixture();
  options.configure?.(files);
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = files.agentDir;
  const faux = fauxProvider({ provider: "team-test", models: [{ id: "default" }, { id: "special", reasoning: true }], tokensPerSecond: Infinity });
  faux.setResponses(Array.from({ length: 100 }, () => options.respond ?? (() => fauxAssistantMessage("完成"))));
  const runtime = await ModelRuntime.create({
    authPath: join(files.agentDir, "auth.json"), modelsPath: join(files.agentDir, "models.json"), refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey("team-test", "test-only-not-a-real-key");
  const settings = SettingsManager.create(files.cwd, files.agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({
    cwd: files.cwd, agentDir: files.agentDir, settingsManager: settings,
    additionalExtensionPaths: options.extension ? [extensionPath] : [],
    extensionFactories: options.factories,
  });
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
  const { session } = await createAgentSession({
    cwd: files.cwd, agentDir: files.agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off",
    resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(files.cwd),
  });
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  const extensionErrors: string[] = [];
  const defaultUI = session.extensionRunner.createContext().ui;
  await session.bindExtensions({
    mode: "tui",
    uiContext: { ...defaultUI, notify: (text) => { notices.push(text); }, setStatus: (_key, value) => { statuses.push(value); } },
    abortHandler: () => { void session.abort(); },
    onError: (error) => { extensionErrors.push(error.error); },
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }), reload: async () => {},
    },
  });
  const env: MemberEnvironment = {
    cwd: files.cwd, agentDir: files.agentDir, model: faux.getModel(), thinkingLevel: "off",
    modelRegistry: new ModelRegistry(runtime), projectTrusted: true, extensionPaths: [],
  };
  return {
    ...files, session, runtime, env, faux, notices, statuses, extensionErrors,
    async close(extra: AgentSession[] = []) {
      try {
        for (const child of extra) await disposeMember(child);
        await disposeMember(session);
      } finally {
        if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousDir;
        files.remove();
      }
    },
  };
}
