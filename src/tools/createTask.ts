import { parseTaskCreationToolInput, taskCreationToolInputSchema } from "../shared/tasks";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const CREATE_TASK_DESCRIPTION = `Create a durable task and switch the current chat into task mode.

This is a one-shot mode change. Use it only after the conversation contains enough detail to provide a complete title, objective, context handoff, acceptance criteria, and dependency-aware work plan. Ask the user only for material missing details before calling it. Load the "task" skill for the complete usage policy.

After this succeeds, the current chat is locked until the task completes, fails, or is cancelled. Do not call another tool or produce a follow-up response after this call.`;

export function createTaskCreationTool(ctx: ToolContext) {
  if (!ctx.createTask || ctx.taskContext || ctx.agentRole) return null;
  return defineTool({
    description: CREATE_TASK_DESCRIPTION,
    inputSchema: taskCreationToolInputSchema,
    execute: async (input) => {
      const creation = parseTaskCreationToolInput(input);
      ctx.log(`tool> createTask ${JSON.stringify({ title: creation.title })}`);
      const result = await ctx.createTask?.(creation);
      if (!result) throw new Error("Task creation handler is unavailable");
      ctx.log(`tool< createTask ${JSON.stringify({ taskId: result.task.id })}`);
      return JSON.stringify({
        taskId: result.task.id,
        title: result.task.title,
        status: result.task.status,
        taskThreadId: result.task.threads[0]?.sessionId ?? null,
        workspaceDisposition: result.workspaceDisposition,
        modeChanged: true,
      });
    },
  });
}
