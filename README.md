# pi-subagents-team

English | [简体中文](README.zh-cn.md)

Turn your current Pi conversation into a team leader that delegates tasks to multiple members. Each member has its own context, model, tools, and skill configuration. Members can work in parallel, and you can send follow-up tasks to the same member.

Requires **Pi 1.2.0** and Node.js 22.18+.

## Installation and quick start

Run these commands from this repository:

```sh
npm install
pi install .
mkdir -p ~/.pi/agent/agents/pi-subagents-team
cp -R examples/dev-team ~/.pi/agent/agents/pi-subagents-team/
```

If you use `PI_CODING_AGENT_DIR`, place your configuration under `agents/pi-subagents-team/` within that directory. The extension resolves the path through Pi's `getAgentDir()`.

Restart Pi or run `/reload` in Pi. To try the extension without installing it, run `pi -e ./index.ts`.

```text
/dev-lead Investigate this project's login flow, fix confirmed issues, and review the changes
Ask reviewer to check the error handling again.
/team
/team exit
```

Running `/dev-lead` without a task only switches modes. Once activated, the leader handles ordinary messages. Repeating the same leader command preserves member context. Switching to another leader ends the previous members' sessions.

`/team` lists available teams and the current members' status. `/team exit` stops running member tasks and restores the tools, model, and thinking level from before team activation. Ordinary conversation history is preserved.

You can also ask in natural language:

```text
Use dev-team to investigate, fix, and review the login flow.
Switch to review-team and check the latest changes.
```

The extension provides the model with available team IDs, leader names, and descriptions. When the model recognizes a request to use a team, it calls `team_activate({ team: "dev-team" })`. It then continues the current task with that leader's role, model, and allowlists, and calls `team_delegate` to assign work. You do not need to repeat the task.

A team's ID is its directory name under `agents/pi-subagents-team/`; use `/team` to see the available IDs. The model interprets natural language and calls the tools; there is no fixed phrase matching. Ambiguous names should be clarified first, and the extension does not force a team switch during ordinary conversation. Reactivating the current team preserves member context; switching teams releases the previous members' sessions.

In Pi 1.2 non-interactive mode, pass a slash command and its task as two separate inputs. Natural-language activation only needs one input:

```sh
pi -p "/dev-lead" "Investigate the login flow and review the implementation"
pi -p "Use dev-team to investigate the login flow and review the implementation"
```

## Configuration

Use one directory per team:

```text
~/.pi/agent/agents/pi-subagents-team/
└── dev-team/
    ├── team.yaml
    ├── leader.md
    ├── scout.md
    ├── worker.md
    └── reviewer.md
```

See `examples/dev-team/` for a complete runnable example. `team.yaml` defines the roles. Markdown files contain only prompts and do not need YAML frontmatter.

```yaml
description: Development team
leader:
  name: dev-lead
  prompt: leader.md
  tools: [read, grep, find, ls]
  skills: []
members:
  - name: worker
    description: Modify code and run tests
    prompt: worker.md
```

| Field | Description |
| --- | --- |
| `description` | Team description; each member must also have a description of its responsibilities |
| `leader` | The team's single leader |
| `members` | One or more members |
| `name` | Must start with a lowercase letter, followed by lowercase letters, digits, or hyphens; the leader's name is also its command name |
| `prompt` | Prompt file, resolved relative to the team's directory |
| `tools` | Optional array of tool names; exact matches only, with no wildcards or `+` / `-` modifiers |
| `skills` | Optional array of skill names; use the names declared by the skills, not file paths |
| `model` | Optional model in `provider/model-id` format; must be configured in the current Pi environment |
| `thinkingLevel` | Optional: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`; Pi adjusts it to the model's capabilities |

Every role can configure its own `model` and `thinkingLevel`. When omitted, these use the model and thinking level from **before team activation**. Configuring a different model for the leader does not change the members' defaults.

`tools` and `skills` are applied independently:

- Omitted: allow all resources of that type available in the current Pi configuration, including those provided by extensions.
- `[]`: allow no resources of that type.
- Array of names: allow only the listed resources. Unknown names cause an error rather than falling back to all resources.

The leader always receives `team_activate` and `team_delegate` in addition to its configured tools, so it can switch teams and delegate work even with `tools: []`. Do not add these two tools to the allowlist. Members do not receive them.

If the model needs to read skill instructions itself, its tool allowlist must include `read`. Configuring a skill does not automatically grant file-reading tools.

All configurations with duplicate leader names are rejected. Member names must be unique within a team. Existing commands and Pi built-in commands are never overwritten by a conflicting name. Run `/reload` after changing configuration or prompts.

## Task execution

The leader can call `team_delegate` with:

```json
{
  "tasks": [
    { "member": "scout", "task": "Investigate the login flow and report relevant files and call relationships" },
    { "member": "reviewer", "task": "Check for gaps in login test coverage" }
  ]
}
```

Different members run concurrently. Once all tasks finish, the tool returns each member's status, output, and usage. Follow-up tasks to the same member reuse its context. A member cannot run two tasks at once or appear twice in the same batch. One member's failure does not discard the other members' results.

Members start independent Pi SDK sessions on demand, using the current project directory, trusted project configuration, and user configuration. They do not receive the leader's full conversation history, so the leader must provide enough context in each task. Extensions in member sessions run in non-interactive mode; extensions that require terminal dialogs may not work. Temporary resources held only in another extension's memory are not guaranteed to be recreated in member sessions. Missing resources explicitly listed in an allowlist cause an error.

In the Pi terminal, `team_delegate` displays members using the current theme. Single tasks and parallel tasks use the same layout. Translated example output:

```text
team_delegate · 2 members
● [scout] [Investigate the login flow] Running · Executing read
✓ [reviewer] [Check for gaps in existing tests] Completed
```

The list retains all members from the current delegation. Each row updates as its task starts, thinks, executes tools, completes, fails, or is canceled. Task summaries collapse line breaks and are truncated to fit the terminal width. Expand the tool result to view full tasks and member output. Colors follow the current Pi theme without additional configuration.

Canceling the leader's current task also cancels the member tasks it is waiting for. Exiting or switching teams, switching Pi sessions, running `/new` or `/reload`, or quitting Pi releases member sessions. Tasks do not continue in the background or resume after a restart. Files modified by members are not reverted.

All members share the same working directory. The example prompts require the leader to assign clear file ownership and avoid concurrent edits to the same file. The extension does not create separate working directories or automatically commit code.

## Allowlist scope

Tool restrictions apply both to the tools visible to the model and to actual tool calls through Pi, including indirect calls made through Pi interfaces by tools such as `codemode`. When tool search changes the active tool list, the role's configuration is restored.

Skill restrictions control the skill catalog provided to a role and `/skill:name` calls. They do not isolate the filesystem. A role with `read` or `bash` may still read other skill files. Skill content already present in conversation history is not erased.

The extension does not audit operations performed directly inside other extensions' JavaScript code, or restrict shell commands and extension commands run manually by the user. To limit a role's operations, choose appropriate tools as well as skills.

## Development and verification

```sh
npm run check
```

Tests use temporary Pi configuration directories and mock models while running real SDK sessions. They do not read user credentials or call paid models. Coverage includes configuration errors, command conflicts, allowlists, parallel delegation, member follow-ups, failures, cancellation, and exiting team mode. CLI tests also load the bundled examples and have scout, worker, and reviewer investigate, fix, and review a temporary JavaScript file in sequence, then call the corrected function to verify the result.

For manual verification, copy the example configuration and run `/dev-lead` in a test project. Complete an investigation, code change, review, and follow-up, then run `/team exit` to check that the original model and tools are restored. Real tasks use the models configured in your Pi environment.

References: [Pi Packages](https://pi.dev/docs/latest/packages), [Pi SDK](https://pi.dev/docs/latest/sdk).
