import { Type, StringEnum } from "@mariozechner/pi-ai";

import { toAgentTool } from "../pi/toolAdapter";
import type { TodoItem } from "../types";
import type { ToolContext } from "./context";

const todoWriteParameters = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "Imperative task description", minLength: 1 }),
      status: StringEnum(["pending", "in_progress", "completed"]),
      activeForm: Type.String({ description: "Present continuous form", minLength: 1 }),
    }),
    { description: "The complete, updated todo list" },
  ),
});

const TODO_WRITE_DESCRIPTION = `Update the progress tracker for multi-step tasks. Sends the COMPLETE todo list each call (overwrite, not append).

Rules:
- Use this for multi-step tasks.
- Exactly one item should be in_progress.
- Mark tasks completed immediately when done.
- Include a final verification step for non-trivial work.`;

export let currentTodos: TodoItem[] = [];

type TodoListener = (todos: TodoItem[]) => void;
const listeners: TodoListener[] = [];

export function onTodoChange(fn: TodoListener) {
  listeners.push(fn);
}

export const todoWrite = toAgentTool({
  name: "todoWrite",
  description: TODO_WRITE_DESCRIPTION,
  parameters: todoWriteParameters,
  execute: async ({ todos }) => {
    currentTodos = todos;
    for (const fn of listeners) fn(todos);

    const summary = todos.map((t: TodoItem) => `[${t.status}] ${t.content}`).join("\n");
    return `Todo list updated:\n${summary}`;
  },
});

export function createTodoWriteTool(ctx: ToolContext) {
  return toAgentTool({
    name: "todoWrite",
    description: TODO_WRITE_DESCRIPTION,
    parameters: todoWriteParameters,
    execute: async ({ todos }) => {
      ctx.log(`tool> todoWrite ${JSON.stringify({ count: todos.length })}`);
      ctx.updateTodos?.(todos);
      currentTodos = todos;
      for (const fn of listeners) fn(todos);

      const summary = todos.map((t: TodoItem) => `[${t.status}] ${t.content}`).join("\n");
      ctx.log(`tool< todoWrite ${JSON.stringify({ count: todos.length })}`);
      return `Todo list updated:\n${summary}`;
    },
  });
}
