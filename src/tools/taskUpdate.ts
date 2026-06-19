import { z } from "zod";

import {
  REQUIREMENT_KINDS,
  TASK_QUESTION_URGENCIES,
  type TaskDirective,
  WORK_ITEM_STATUSES,
} from "../shared/tasks";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const base = {
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "Stable unique key for this logical directive; reuse it only when retrying the same operation",
    ),
};

const taskDirectiveSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("update_plan"),
      expectedRevision: z.number().int().nonnegative(),
      objective: z.string().trim().min(1).optional(),
      requirements: z
        .array(
          z
            .object({
              kind: z.enum(REQUIREMENT_KINDS),
              text: z.string().trim().min(1),
              permanence: z.enum(["fixed", "temporary"]).optional(),
            })
            .strict(),
        )
        .optional(),
      workItems: z.array(
        z
          .object({
            id: z.string().trim().min(1).optional(),
            title: z.string().trim().min(1),
            description: z.string().optional(),
            dependsOn: z.array(z.string().trim().min(1)).optional(),
            expectedOutputs: z.array(z.string().trim().min(1)).optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("mark_work_item"),
      expectedRevision: z.number().int().nonnegative(),
      workItemId: z.string().trim().min(1),
      status: z.enum(WORK_ITEM_STATUSES),
      completionEvidence: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("record_decision"),
      expectedRevision: z.number().int().nonnegative(),
      question: z.string().trim().min(1),
      resolution: z.string().trim().min(1),
      confidence: z.number().min(0).max(1).optional(),
      scope: z.enum(["task", "project"]).optional(),
      supersedes: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("report_progress"),
      summary: z.string().trim().min(1),
      detail: z.string().optional(),
      workItemId: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("request_input"),
      expectedRevision: z.number().int().nonnegative(),
      questions: z
        .array(
          z
            .object({
              header: z.string().trim().min(1).max(40),
              question: z.string().trim().min(1),
              context: z.string().optional(),
              blocking: z.boolean(),
              urgency: z.enum(TASK_QUESTION_URGENCIES),
              defaultAction: z.string().trim().min(1).optional(),
              options: z
                .array(
                  z
                    .object({
                      id: z.string().trim().min(1),
                      label: z.string().trim().min(1),
                      description: z.string().optional(),
                    })
                    .strict(),
                )
                .min(2)
                .max(3)
                .optional(),
              recommendedOptionId: z.string().trim().min(1).optional(),
              workItemId: z.string().trim().min(1).optional(),
              supersedes: z.string().trim().min(1).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(3),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("report_blocker"),
      expectedRevision: z.number().int().nonnegative(),
      description: z.string().trim().min(1),
      blocking: z.boolean(),
      workItemId: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("register_artifact"),
      expectedRevision: z.number().int().nonnegative(),
      path: z.string().trim().min(1),
      title: z.string().trim().min(1),
      kind: z.string().trim().min(1),
      artifactId: z.string().trim().min(1).optional(),
      baseVersionId: z.string().trim().min(1).optional(),
      changeSummary: z.string().trim().min(1).optional(),
      workItemId: z.string().trim().min(1).optional(),
      provenance: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("propose_completion"),
      expectedRevision: z.number().int().nonnegative(),
      summary: z.string().trim().min(1),
      caveats: z.array(z.string().trim().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("create_thread"),
      expectedRevision: z.number().int().nonnegative(),
      title: z.string().trim().min(1),
      workItemId: z.string().trim().min(1),
    })
    .strict(),
]);

const TASK_UPDATE_DESCRIPTION = `Update the shared task record for this task-mode thread.

Use this instead of chat todos. The task coordinator validates graph dependencies, work ownership, revision conflicts, artifacts, lifecycle transitions, and completion readiness.

Use request_input only for decisions with material consequences. Batch related questions. Non-blocking questions require a reversible default and let work continue; blocking questions pause the task after this tool call.

Mutating directives require the latest task revision. The tool result returns the new revision. Use a stable unique idempotencyKey so retrying the same logical directive cannot duplicate it.`;

export function createTaskUpdateTool(ctx: ToolContext) {
  if (!ctx.taskContext || !ctx.applyTaskDirective) return null;
  return defineTool({
    description: TASK_UPDATE_DESCRIPTION,
    inputSchema: taskDirectiveSchema,
    execute: async (input: z.input<typeof taskDirectiveSchema>) => {
      const directive: TaskDirective = taskDirectiveSchema.parse(input);
      ctx.log(`tool> taskUpdate ${JSON.stringify({ type: directive.type })}`);
      const result = await ctx.applyTaskDirective?.(directive);
      if (!result) throw new Error("Task directive handler is unavailable");
      const { task } = result;
      ctx.log(
        `tool< taskUpdate ${JSON.stringify({ type: directive.type, revision: task.revision })}`,
      );
      return JSON.stringify({
        taskId: task.id,
        status: task.status,
        revision: task.revision,
        completedWorkItems: task.completedWorkItemCount,
        totalWorkItems: task.totalWorkItemCount,
        activeBlockers: task.activeBlockerCount,
        pendingQuestions: task.pendingQuestionCount,
        blockingQuestions: task.blockingQuestionCount,
        continuation: result.continuation,
      });
    },
  });
}
