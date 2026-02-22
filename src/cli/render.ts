import type { ServerEvent } from "../server/protocol";
import type { TodoItem } from "../types";

type ToolListEntry = Extract<ServerEvent, { type: "tools" }>["tools"][number] | string;

export function renderTodosToLines(todos: TodoItem[]): string[] {
  if (todos.length === 0) return [];

  const lines = ["\n--- Progress ---"];
  for (const todo of todos) {
    const icon = todo.status === "completed" ? "x" : todo.status === "in_progress" ? ">" : "-";
    lines.push(`  ${icon} ${todo.content}`);
  }
  const active = todos.find((t) => t.status === "in_progress");
  if (active) lines.push(`\n  ${active.activeForm}...`);
  lines.push("");
  return lines;
}

export function renderToolsToLines(tools: ToolListEntry[]): string[] {
  return tools.map((tool) => {
    if (typeof tool === "string") return `  - ${tool}`;
    const name = typeof tool?.name === "string" ? tool.name : "unknown";
    const description = typeof tool?.description === "string" ? tool.description.trim() : "";
    if (!description || description === name) return `  - ${name}`;
    return `  - ${name}: ${description}`;
  });
}
