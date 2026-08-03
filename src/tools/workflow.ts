import { z } from "zod";

import { WORKFLOW_TOOL_DESCRIPTION } from "../workflows/authoringPrompt";
import { resolveWorkflowsFeatureEnabled } from "../workflows/flags";
import { assertSafeWorkflowRunId } from "../workflows/journal";
import {
  assertWorkflowDefinitionName,
  listWorkflowDefinitions,
  resolveWorkflowDefinition,
  saveWorkflowDefinition,
} from "../workflows/registry";
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

const workflowNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => {
    try {
      assertWorkflowDefinitionName(value);
      return true;
    } catch {
      return false;
    }
  }, "workflow names use lowercase letters, digits, and single hyphens");

const inputSchema = z
  .object({
    action: z.enum(["run", "save", "list"]).default("run"),
    name: workflowNameSchema.optional().describe("Registered workflow name."),
    script: z
      .string()
      .trim()
      .min(1)
      .max(200_000)
      .optional()
      .describe("The workflow script: a TS module exporting `meta` and a default function."),
    scope: z
      .enum(["project", "global"])
      .optional()
      .describe("Where to save a reusable workflow definition."),
    overwrite: z
      .boolean()
      .optional()
      .describe("Replace an existing workflow in the selected scope."),
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
    if (value.action === "run") {
      const sourceCount = Number(Boolean(value.name)) + Number(Boolean(value.script));
      if (sourceCount !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["script"],
          message: "run requires exactly one of name or script",
        });
      }
      if (value.scope !== undefined || value.overwrite !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["scope"],
          message: "scope and overwrite are only valid for action=save",
        });
      }
      if (value.dryRun === true && value.resumeFromRunId) {
        ctx.addIssue({
          code: "custom",
          path: ["resumeFromRunId"],
          message: "dryRun cannot resume from a prior journal",
        });
      }
      return;
    }

    if (value.action === "save") {
      if (!value.name) {
        ctx.addIssue({ code: "custom", path: ["name"], message: "save requires name" });
      }
      if (!value.script) {
        ctx.addIssue({ code: "custom", path: ["script"], message: "save requires script" });
      }
      if (!value.scope) {
        ctx.addIssue({ code: "custom", path: ["scope"], message: "save requires scope" });
      }
      if (value.args !== undefined || value.resumeFromRunId || value.dryRun !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["args"],
          message: "args, resumeFromRunId, and dryRun are only valid for action=run",
        });
      }
      return;
    }

    if (
      value.name ||
      value.script ||
      value.scope ||
      value.overwrite !== undefined ||
      value.args !== undefined ||
      value.resumeFromRunId ||
      value.dryRun !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["action"],
        message: "list does not accept run or save fields",
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

      if (input.action === "list") {
        const catalog = await listWorkflowDefinitions(ctx.config);
        ctx.log(
          `tool< workflow ${JSON.stringify({ action: "list", workflows: catalog.workflows.length })}`,
        );
        return { ok: true as const, ...catalog };
      }

      if (input.action === "save") {
        await ctx.assertCanMutate?.("workflow");
        if (!input.name || !input.scope || !input.script) {
          throw new Error("workflow save input validation failed");
        }
        const saved = await saveWorkflowDefinition({
          config: ctx.config,
          name: input.name,
          scope: input.scope,
          source: input.script,
          ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}),
        });
        ctx.log(
          `tool< workflow ${JSON.stringify({
            action: "save",
            name: saved.name,
            scope: saved.scope,
          })}`,
        );
        return { ok: true as const, saved };
      }

      const definition = input.name
        ? await resolveWorkflowDefinition(ctx.config, input.name)
        : null;
      const script = definition?.source ?? input.script;
      if (!script) throw new Error("workflow run input validation failed");
      ctx.log(
        `tool> workflow ${JSON.stringify({
          action: "run",
          name: definition?.name ?? null,
          scope: definition?.scope ?? null,
          scriptBytes: script.length,
          hasArgs: input.args !== undefined,
          resumeFromRunId: input.resumeFromRunId ?? null,
          dryRun: input.dryRun === true,
        })}`,
      );
      await ctx.assertCanMutate?.("workflow");

      const outcome = await runWorkflow({
        ctx,
        control: agentControl,
        script,
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
      return {
        ok: true as const,
        ...summary,
        ...(definition
          ? {
              definition: {
                name: definition.name,
                scope: definition.scope,
                path: definition.path,
              },
            }
          : {}),
      };
    },
  });
}
