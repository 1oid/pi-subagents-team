import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { MemberProgress, MemberResult, Task } from "./members.ts";

export interface TaskRow extends Task {
  status: "pending" | MemberProgress["status"];
  activity?: string;
}

export interface DelegateDetails {
  tasks: TaskRow[];
  results?: MemberResult[];
}

const statuses = {
  pending: { icon: "○", label: "等待中", color: "muted" },
  running: { icon: "●", label: "运行中", color: "warning" },
  completed: { icon: "✓", label: "已完成", color: "success" },
  failed: { icon: "✗", label: "失败", color: "error" },
  cancelled: { icon: "–", label: "已取消", color: "muted" },
} as const;

function singleLine(text: string): string {
  return stripTerminalSequences(text).replace(/\s+/g, " ").trim();
}

function taskList(tasks: TaskRow[], theme: Theme): Component {
  return {
    invalidate() {},
    render(width) {
      return tasks.map((task) => {
        const status = statuses[task.status];
        const name = theme.fg("accent", `[${singleLine(task.member)}]`);
        const summary = theme.fg("toolOutput", `[${truncateToWidth(singleLine(task.task), 64)}]`);
        const activity = task.activity ? ` · ${singleLine(task.activity)}` : "";
        return truncateToWidth(`${theme.fg(status.color, status.icon)} ${name} ${summary} ${theme.fg(status.color, status.label)}${theme.fg("dim", activity)}`, width);
      });
    },
  };
}

export const delegateRenderers: Pick<ToolDefinition<TSchema, DelegateDetails>, "renderCall" | "renderResult"> = {
  renderCall(args, theme, context) {
    // Pi 在参数仍在生成时也会渲染，尚未完整的成员显示占位文字。
    const tasks = (args as { tasks?: Partial<Task>[] } | undefined)?.tasks ?? [];
    const container = new Container();
    container.addChild(new Text(theme.fg("toolTitle", theme.bold("team_delegate")) + theme.fg("muted", ` · ${tasks.length} 位成员`), 0, 0));
    if (!context.executionStarted) {
      container.addChild(taskList(tasks.map((task) => ({ member: task.member ?? "…", task: task.task ?? "…", status: "pending" })), theme));
    }
    return container;
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    if (!result.details) {
      return new Text(theme.fg(context.isError ? "error" : "toolOutput", result.content
        .filter((part) => part.type === "text").map((part) => part.text).join("\n")), 0, 0);
    }
    const container = new Container();
    container.addChild(taskList(result.details.tasks, theme));
    if (expanded) {
      for (const task of result.details.tasks) {
        container.addChild(new Text(`\n${theme.fg("accent", `[${task.member}]`)} ${theme.fg("muted", "完整任务")}\n${stripTerminalSequences(task.task)}`, 0, 0));
        const output = result.details.results?.find((item) => item.member === task.member)?.output;
        if (output) container.addChild(new Text(stripTerminalSequences(output), 0, 0));
      }
    } else if (!isPartial) {
      container.addChild(new Text(theme.fg("dim", "展开查看完整任务和成员结果"), 0, 0));
    }
    return container;
  },
};
