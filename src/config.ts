import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parseDocument } from "yaml";

// Pi 1.2 的内置命令不在 ExtensionAPI.getCommands() 的返回值里。
export const reservedCommands = new Set([
  "team", "settings", "model", "tree", "thinking", "scoped-models", "export",
  "import", "share", "bug", "copy", "name", "session", "changelog", "hotkeys",
  "fork", "clone", "trust", "login", "logout", "new", "compact", "resume", "reload", "quit",
]);

const names = Type.Array(Type.String({ minLength: 1, pattern: "^[^\\s*+\\-][^\\s*]*$" }), { uniqueItems: true });
const roleFields = {
  name: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
  prompt: Type.String({ minLength: 1 }),
  tools: Type.Optional(names),
  skills: Type.Optional(names),
  model: Type.Optional(Type.String({ pattern: "^[^/\\s]+/[^\\s]+$" })),
  thinkingLevel: Type.Optional(Type.Union([
    Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"),
    Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"),
  ])),
};
const roleSchema = Type.Object(roleFields, { additionalProperties: false });
const memberSchema = Type.Object({ ...roleFields, description: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const teamSchema = Type.Object({
  description: Type.String({ minLength: 1 }),
  leader: roleSchema,
  members: Type.Array(memberSchema, { minItems: 1 }),
}, { additionalProperties: false });

export type Role = Static<typeof roleSchema> & { promptText: string };
export type Member = Role & { description: string };
export interface Team {
  id: string;
  description: string;
  leader: Role;
  members: Member[];
}

export function loadTeams(root: string): { teams: Team[]; errors: string[] } {
  const teams: Team[] = [];
  const errors: string[] = [];
  if (!existsSync(root)) return { teams, errors };
  for (const dir of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dir.isDirectory()) continue;
    const file = join(root, dir.name, "team.yaml");
    try {
      const document = parseDocument(readFileSync(file, "utf8"));
      if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
      const value: unknown = document.toJS();
      if (!Value.Check(teamSchema, value)) {
        throw new Error("配置格式错误：" + [...Value.Errors(teamSchema, value)]
          .map((error) => `${error.instancePath || "/"}: ${error.message}`).join("; "));
      }
      if (reservedCommands.has(value.leader.name)) throw new Error(`leader 名称 ${value.leader.name} 与保留命令冲突`);
      const memberNames = value.members.map((member) => member.name);
      if (new Set(memberNames).size !== memberNames.length) throw new Error("成员名称重复");
      const roles = [value.leader, ...value.members].map((role) => {
        const promptText = readFileSync(resolve(root, dir.name, role.prompt), "utf8").trim();
        if (!promptText) throw new Error(`${role.name} 的提示词为空`);
        if (role.tools?.some((name) => name === "team_delegate" || name === "team_activate")) {
          throw new Error("team_activate 和 team_delegate 由插件提供给 leader，不应写入 tools");
        }
        return { ...role, promptText };
      });
      teams.push({ id: dir.name, description: value.description, leader: roles[0], members: roles.slice(1) as Member[] });
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const duplicates = new Set(teams.filter((team, i) => teams.some((other, j) => i !== j && other.leader.name === team.leader.name))
    .map((team) => team.leader.name));
  for (const name of duplicates) errors.push(`leader 名称重复：${name}，这些小队均未加载`);
  return { teams: teams.filter((team) => !duplicates.has(team.leader.name)), errors };
}
