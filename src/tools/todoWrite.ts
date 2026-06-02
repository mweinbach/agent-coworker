import { z } from "zod";

import type { TodoItem } from "../types";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const todoSchema = z.object({
  content: z.string().min(1).describe("Imperative task description"),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().min(1).describe("Present continuous form"),
});
const todoWriteInputSchema = z
  .object({
    todos: z.array(todoSchema).describe("The complete, updated todo list"),
  })
  .superRefine((value, ctx) => {
    const inProgressCount = value.todos.filter((todo) => todo.status === "in_progress").length;
    if (inProgressCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["todos"],
        message: "At most one todo may be in_progress.",
      });
    }
  });

export let currentTodos: TodoItem[] = [];

type TodoListener = (todos: TodoItem[]) => void;
const listeners: TodoListener[] = [];

export function onTodoChange(fn: TodoListener) {
  listeners.push(fn);
}

const todoWrite = defineTool({
  description: `Update the progress tracker for multi-step tasks. Sends the COMPLETE todo list each call (overwrite, not append).

Rules:
- Use this for multi-step tasks.
- No more than one item should be in_progress; when work is done, all items may be completed.
- Mark tasks completed immediately when done.
- Include a final verification step for non-trivial work.`,
  inputSchema: todoWriteInputSchema,
  execute: async (input: z.input<typeof todoWriteInputSchema>) => {
    const { todos } = todoWriteInputSchema.parse(input);
    currentTodos = todos;
    for (const fn of listeners) fn(todos);

    const summary = todos.map((todo: TodoItem) => `[${todo.status}] ${todo.content}`).join("\n");
    return `Todo list updated:\n${summary}`;
  },
});

export function createTodoWriteTool(ctx: ToolContext) {
  return defineTool({
    description: todoWrite.description,
    inputSchema: todoWriteInputSchema,
    execute: async (input: z.input<typeof todoWriteInputSchema>) => {
      const { todos } = todoWriteInputSchema.parse(input);
      ctx.log(`tool> todoWrite ${JSON.stringify({ count: todos.length })}`);
      ctx.updateTodos?.(todos);
      // Keep global store updated too, so existing CLI renderers still work.
      currentTodos = todos;
      for (const fn of listeners) fn(todos);

      const summary = todos.map((t: TodoItem) => `[${t.status}] ${t.content}`).join("\n");
      ctx.log(`tool< todoWrite ${JSON.stringify({ count: todos.length })}`);
      return `Todo list updated:\n${summary}`;
    },
  });
}
