import { z } from "zod";

import { WORKFLOW_TOOL_DESCRIPTION } from "../workflows/authoringPrompt";
import { resolveWorkflowsFeatureEnabled } from "../workflows/flags";
import { assertSafeWorkflowRunId } from "../workflows/journal";
import { runWorkflow } from "../workflows/WorkflowRunner";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const workflowRunIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      assertSafeWorkflowRunId(value);
      return true;
    } catch {
      return false;
    }
  }, "resumeFromRunId must look like a host run id (wf_…) and cannot contain path separators")
  .describe(
    "Replay a prior run's journal: unchanged agent() calls return cached results instantly.",
  );

const inputSchema = z
  .object({
    script: z
      .string()
      .trim()
      .min(1)
      .max(200_000)
      .describe("The workflow script: a TS module exporting `meta` and a default function."),
    args: z
      .unknown()
      .optional()
      .describe("Value exposed to the script as `args`. Pass real JSON, not a JSON string."),
    resumeFromRunId: workflowRunIdSchema.optional(),
    dryRun: z
      .boolean()
      .optional()
      .describe("Execute the script with agent() stubbed. Spawns nothing; reports the call graph."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dryRun === true && value.resumeFromRunId) {
      ctx.addIssue({
        code: "custom",
        path: ["resumeFromRunId"],
        message: "dryRun cannot resume from a prior journal",
      });
    }
  });

export function createWorkflowTool(ctx: ToolContext) {
  if (!resolveWorkflowsFeatureEnabled(ctx.config)) return null;
  const agentControl = ctx.agentControl;
  if (!agentControl) return null;

  return defineTool({
    description: WORKFLOW_TOOL_DESCRIPTION,
    inputSchema,
    execute: async (rawInput: z.input<typeof inputSchema>) => {
      const input = inputSchema.parse(rawInput);
      ctx.log(
        `tool> workflow ${JSON.stringify({
          scriptBytes: input.script.length,
          hasArgs: input.args !== undefined,
          resumeFromRunId: input.resumeFromRunId ?? null,
          dryRun: input.dryRun === true,
        })}`,
      );
      await ctx.assertCanMutate?.("workflow");

      const outcome = await runWorkflow({
        ctx,
        control: agentControl,
        script: input.script,
        ...(ctx.onWorkflowProgress ? { onProgress: ctx.onWorkflowProgress } : {}),
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.resumeFromRunId ? { resumeFromRunId: input.resumeFromRunId } : {}),
        ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      });

      // A compile failure is returned as a value, not thrown: the model repairs
      // the script in-context at zero spend instead of burning a turn on an error.
      if (!outcome.ok) {
        ctx.log(`tool< workflow ${JSON.stringify({ ok: false, issues: outcome.issues.length })}`);
        return {
          ok: false as const,
          error: "the workflow script did not compile",
          issues: outcome.issues,
        };
      }

      const { summary } = outcome;
      ctx.log(
        `tool< workflow ${JSON.stringify({
          runId: summary.runId,
          agents: summary.agentCount,
          cached: summary.cachedCount,
          errored: summary.erroredCount,
          durationMs: summary.durationMs,
        })}`,
      );
      return { ok: true as const, ...summary };
    },
  });
}
