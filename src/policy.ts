import { formatSkillsForPrompt, type ExtensionAPI, type Skill, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import type { Role } from "./config.ts";

export function validateResources(role: Role, tools: Pick<ToolInfo, "name" | "exposure">[], skills: Skill[]): void {
  const availableTools = new Set(tools.filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name));
  const availableSkills = new Set(skills.map((skill) => skill.name));
  const missingTools = role.tools?.filter((name) => !availableTools.has(name)) ?? [];
  const missingSkills = role.skills?.filter((name) => !availableSkills.has(name)) ?? [];
  if (missingTools.length || missingSkills.length) {
    throw new Error(`${role.name} 的配置无法使用：` + [
      missingTools.length && `找不到工具 ${missingTools.join(", ")}`,
      missingSkills.length && `找不到 skill ${missingSkills.join(", ")}`,
    ].filter(Boolean).join("；"));
  }
}

export function selectedTools(role: Role, tools: Pick<ToolInfo, "name" | "exposure">[], leader: boolean): string[] {
  const selected = role.tools ?? tools.filter((tool) => tool.exposure !== "hidden" && tool.name !== "team_delegate" && tool.name !== "team_activate").map((tool) => tool.name);
  return leader ? [...selected, "team_activate", "team_delegate"] : selected;
}

/** 同一套约束用于当前对话的 leader 和独立成员会话。 */
export function installPolicy(pi: ExtensionAPI, getRole: () => Role | undefined, leader: boolean): () => Skill[] {
  let availableSkills: Skill[] = [];
  pi.on("before_agent_start", (event) => {
    availableSkills = event.systemPromptOptions.skills.slice();
    const role = getRole();
    if (!role) return;
    event.systemPromptOptions.selectedTools = selectedTools(role, pi.getAllTools(), leader);
    event.systemPromptOptions.sections["team_role"] = role.promptText;
    if (role.skills !== undefined) {
      event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter((skill) => role.skills!.includes(skill.name));
    }
  });
  if (leader) {
    pi.on("context_with_system", (event) => {
      const role = getRole();
      if (!role) return;
      // 激活工具可在当前回答中换队。下一次请求就应用新角色，不等下一条用户消息。
      const head = getCurrentSystemMessage(event.messages);
      if (!head) return;
      const tools = getCurrentTools(event.messages).map((tool) => tool.name);
      const activeTools = pi.getActiveTools();
      const reader = tools.includes("read") ? "read" : tools.includes("bash") ? "bash"
        : activeTools.some((name) => name === "read" || name === "bash") ? "indirect" : undefined;
      const skills = role.skills === undefined ? availableSkills : availableSkills.filter((skill) => role.skills!.includes(skill.name));
      const skillPrompt = reader ? formatSkillsForPrompt(skills, reader).trim() : "";
      head.sections = { ...head.sections, team_role: `<team_role>\n${role.promptText}\n</team_role>`,
        skills: skillPrompt ? `<skills>\n${skillPrompt}\n</skills>` : null };
      return { messages: [head, ...event.messages.filter((message) => message.role !== "system")] };
    });
  }
  pi.on("input", (event, ctx) => {
    const role = getRole();
    const skill = /^\/skill:([^\s]+)/.exec(event.text)?.[1];
    if (role?.skills !== undefined && skill && !role.skills.includes(skill)) {
      ctx.ui.notify(`${role.name} 未获准使用 skill：${skill}`, "error");
      return { action: "handled" };
    }
  });
  pi.on("tool_call", (event) => {
    const role = getRole();
    if (!role) return;
    if (event.toolName === "team_delegate" || event.toolName === "team_activate"
      ? !leader : role.tools !== undefined && !role.tools.includes(event.toolName)) {
      return { block: true, reason: `${role.name} 未获准使用工具：${event.toolName}` };
    }
  });
  // tool_search 等扩展可能改变激活列表；在工具返回后恢复角色的工具列表。
  pi.on("tool_result", () => {
    const role = getRole();
    if (role) pi.setActiveTools(selectedTools(role, pi.getAllTools(), leader));
  });
  return () => availableSkills;
}
