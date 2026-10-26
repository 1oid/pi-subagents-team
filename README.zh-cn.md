# pi-subagents-team

[English](README.md) | 简体中文

让当前 Pi 对话充当 leader，由它给多个成员派工。成员各有自己的上下文、模型、工具和 skill 配置。支持并行工作，以及继续向原成员追问。

需要 **Pi 1.2.0** 和 Node.js 22.18+。

## 安装与试用

在本仓库执行：

```sh
npm install
pi install .
mkdir -p ~/.pi/agent/agents/pi-subagents-team
cp -R examples/dev-team ~/.pi/agent/agents/pi-subagents-team/
```

如果使用了 `PI_CODING_AGENT_DIR`，把配置放到该目录的 `agents/pi-subagents-team/` 下。插件通过 Pi 的 `getAgentDir()` 获取路径。

重新启动 Pi，或在 Pi 中执行 `/reload`。也可以不安装，临时执行 `pi -e ./index.ts`。

```text
/dev-lead 调查这个项目的登录流程，修复已确认的问题并审查修改
请让 reviewer 再检查一下错误处理。
/team
/team exit
```

`/dev-lead` 不带任务只切换模式。进入之后，普通消息都由 leader 处理。再次输入同一个 leader 命令不会清空成员上下文。切换到其他 leader 时，旧成员会话结束。

`/team` 列出可用小队和当前成员状态。`/team exit` 停止正在执行的成员任务，恢复进入小队前的工具、模型和思考强度。普通对话历史保留。

也可以直接说：

```text
使用 dev-team 进行登录流程的调查、修复和审查。
切换到 review-team，检查刚才的修改。
```

插件会把可用小队的 ID、leader 名称和说明提供给模型。模型识别到使用小队的要求后，调用 `team_activate({ team: "dev-team" })`；激活完成就以对应 leader 的角色、模型和白名单继续当前任务，再调用 `team_delegate` 派工，不需要重发任务。

小队 ID 就是 `agents/pi-subagents-team/` 下的目录名，`/team` 可以查看。这里只由模型理解自然语言并调用工具，没有固定句式匹配；名称不明确时应先澄清，普通对话不会由插件强制切队。重复激活当前小队保留成员上下文，切换到其他小队会释放旧成员会话。

Pi 1.2 的非交互模式使用斜杠命令时，需要将命令和任务作为两个输入传入；使用自然语言激活时只需一个输入：

```sh
pi -p "/dev-lead" "调查登录流程并审查实现"
pi -p "使用 dev-team 调查登录流程并审查实现"
```

## 配置

每个小队一个目录：

```text
~/.pi/agent/agents/pi-subagents-team/
└── dev-team/
    ├── team.yaml
    ├── leader.md
    ├── scout.md
    ├── worker.md
    └── reviewer.md
```

完整的可运行示例见 `examples/dev-team/`。`team.yaml` 定义角色，Markdown 文件只写提示词，不需要 YAML frontmatter。

```yaml
description: 开发小队
leader:
  name: dev-lead
  prompt: leader.md
  tools: [read, grep, find, ls]
  skills: []
members:
  - name: worker
    description: 修改代码并运行测试
    prompt: worker.md
```

| 字段 | 含义 |
| --- | --- |
| `description` | 小队说明；每个成员也必须有职责说明 |
| `leader` | 唯一的 leader |
| `members` | 一个或多个成员 |
| `name` | 小写字母开头，后续允许小写字母、数字和连字符；leader 名即调用命令 |
| `prompt` | 提示词文件，相对于本小队目录解析 |
| `tools` | 可选的工具名称数组，精确匹配，不支持通配符或 `+` / `-` 修饰 |
| `skills` | 可选的技能名称数组，使用技能声明的名称，不是路径 |
| `model` | 可选，格式为 `provider/model-id`，必须是当前 Pi 已配置的模型 |
| `thinkingLevel` | 可选：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`；Pi 会按模型能力调整 |

所有角色都可以分别配置 `model` 和 `thinkingLevel`。省略时使用**进入小队前**的模型和思考强度，不会因为 leader 配了另一个模型就改变成员默认值。

`tools` 与 `skills` 独立生效：

- 省略：开放当前 Pi 配置中可用的这一类资源，包括扩展提供的内容。
- `[]`：不开放任何这一类资源。
- 名称数组：只开放列出的项。名称不存在则报错，不回退到全部资源。

leader 始终额外拥有 `team_activate` 和 `team_delegate`，即使 `tools: []` 也能切换小队和派工。不要把这两个工具写进白名单，成员没有这两个工具。

让模型自行读取 skill 说明时，工具白名单也需要允许 `read`。插件不会因为配置了 skill 就偷偷增加文件读取工具。

同名 leader 的所有配置都会被拒绝；同队成员不能重名。与已有命令或 Pi 内置命令重名时不会覆盖原命令。修改配置或提示词后执行 `/reload`。

## 执行方式

leader 可以调用：

```json
{
  "tasks": [
    { "member": "scout", "task": "调查登录流程，返回相关文件和调用关系" },
    { "member": "reviewer", "task": "检查登录相关测试有哪些遗漏" }
  ]
}
```

不同成员同时执行，全部结束后返回各自状态、输出和用量。再次给同一成员派工时复用上下文。同一成员不能同时执行两个任务，也不能在一批任务中重复出现。一个成员失败不会丢掉其他成员的结果。

成员按需启动独立 Pi SDK 会话，使用当前项目目录、已信任的项目配置和用户配置。成员不会获得 leader 的完整聊天记录；leader 应在任务中提供足够背景。成员中的扩展按非交互模式运行，依赖终端对话框的扩展可能无法使用。仅存在于其他扩展内存中的临时资源不能保证在成员中重建；显式白名单资源缺失会报错。

`team_delegate` 在 Pi 终端中使用当前主题显示成员列表，单个任务和并行任务采用相同布局：

```text
team_delegate · 2 位成员
● [scout] [调查登录流程] 运行中 · 执行 read
✓ [reviewer] [检查现有测试的遗漏] 已完成
```

列表会保留本次派工的所有成员，每行随启动、思考、工具执行、完成、失败或取消更新。任务简介自动合并换行并截短，适配终端宽度；展开工具结果可查看完整任务和成员输出。颜色跟随当前 Pi 主题，无需额外配置。

取消 leader 当前任务时会同时取消它正在等待的成员任务。退出小队、切换小队、切换 Pi 会话、`/new`、`/reload` 或退出 Pi 都会释放成员会话；不做后台运行或重启恢复。成员修改过的文件不会因此撤销。

所有成员共享工作目录，示例要求 leader 分清文件职责，不同时安排修改同一文件。插件不创建独立工作目录，也不自动提交代码。

## 白名单的范围

工具限制同时用于模型可见列表和 Pi 的实际工具调用，包括 `codemode` 等工具通过 Pi 接口发起的间接调用。工具搜索改变激活列表后会恢复角色配置。

skill 限制控制提供给角色的技能目录和 `/skill:name` 调用，不是文件系统隔离。允许 `read` 或 `bash` 后，角色仍然可能读取其他技能文件。已存在于对话历史中的技能内容也不会被抹除。

插件不审计其他扩展在 JavaScript 内部直接执行的操作，也不限制用户手动执行的 shell 命令或扩展命令。需要限制角色操作范围时，应同时选择合适的工具，不要只限制 skill。

## 开发与验证

```sh
npm run check
```

测试使用临时 Pi 配置目录和模拟模型，真实运行 SDK 会话，不读取用户认证，也不调用付费模型。覆盖配置错误、命令冲突、白名单、并行派工、成员追问、失败、取消和模式退出。命令行测试还会加载随附示例，让 scout、worker、reviewer 依次调查、修复、审查临时 JavaScript 文件，再实际调用修复后的函数验证结果。

手动验收：复制示例配置，在一个测试项目中运行 `/dev-lead`，完成调查、修改、审查和追问，再运行 `/team exit` 检查原模型及工具恢复。真实任务会使用你在 Pi 中配置的模型。

参考：[Pi Packages](https://pi.dev/docs/latest/packages)、[Pi SDK](https://pi.dev/docs/latest/sdk)。
