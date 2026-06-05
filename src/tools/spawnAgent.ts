import path from "node:path";
import { z } from "zod";

import { isUsableTargetPath } from "../platform/sandbox/policy";
import {
  AGENT_ROLE_VALUES,
  agentContextModeSchema,
  agentReasoningEffortSchema,
  agentTargetPathsSchema,
  agentTaskTypeSchema,
  normalizeAgentTargetPaths,
  resolveAgentSpawnContextOptions,
} from "../shared/agents";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

function requireAgentControl(ctx: ToolContext) {
  if (!ctx.agentControl) {
    throw new Error("Child agents are unavailable outside a session-backed turn.");
  }
  return ctx.agentControl;
}

export function createSpawnAgentTool(ctx: ToolContext) {
  const inputSchema = z
    .object({
      message: z.string().trim().min(1).max(20_000),
      role: z.enum(AGENT_ROLE_VALUES).optional().default("default"),
      profileRef: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Specialized subagent profile ref. Use a bare id or scoped ref like 'workspace:reviewer'. When provided, it wins over role.",
        ),
      model: z.string().trim().min(1).optional(),
      reasoningEffort: agentReasoningEffortSchema.optional(),
      nickname: z.string().trim().min(1).optional(),
      taskType: agentTaskTypeSchema.optional(),
      targetPaths: agentTargetPathsSchema
        .optional()
        .describe(
          "Filesystem scope for the child. File tools must stay inside these paths; omit only when the child needs the whole workspace.",
        ),
      contextMode: agentContextModeSchema
        .optional()
        .describe(
          "Context handoff mode. Defaults to 'none' for compatibility: no parent conversation, files, history, or assumptions are included. If set to 'brief', you must also provide briefing. Use 'full' only when the transcript is required.",
        ),
      briefing: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .optional()
        .describe(
          "Required when contextMode is 'brief'. Summarize the parent context the child needs.",
        ),
      includeParentTodos: z.boolean().optional(),
      includeHarnessContext: z.boolean().optional(),
      forkContext: z
        .boolean()
        .optional()
        .describe("Deprecated compatibility flag; prefer contextMode='full'."),
    })
    .superRefine((value, issueContext) => {
      try {
        resolveAgentSpawnContextOptions(value);
      } catch (error) {
        issueContext.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  return defineTool({
    description:
      "Spawn a collaborative child agent for a well-scoped task. Prefer contextMode='brief' with an explicit briefing for most handoffs. contextMode='none' includes no parent conversation, files, history, or assumptions, so the message must be fully self-contained. Use contextMode='full' only when the child truly needs the full parent transcript. targetPaths are enforced as the child file-tool scope when provided. The optional profileRef selects a specialized subagent profile by bare id or scoped ref and wins over role. The optional model override may be a same-provider model id or a provider:modelId child target ref. Returns the child handle to use with sendAgentInput, waitForAgent, inspectAgent, resumeAgent, and closeAgent.",
    inputSchema,
    execute: async ({
      message,
      role,
      profileRef,
      model,
      reasoningEffort,
      nickname,
      taskType,
      targetPaths,
      contextMode,
      briefing,
      includeParentTodos,
      includeHarnessContext,
      forkContext,
    }: {
      message: string;
      role?: (typeof AGENT_ROLE_VALUES)[number];
      profileRef?: string;
      model?: string;
      reasoningEffort?: z.infer<typeof agentReasoningEffortSchema>;
      nickname?: string;
      taskType?: z.infer<typeof agentTaskTypeSchema>;
      targetPaths?: z.infer<typeof agentTargetPathsSchema>;
      contextMode?: z.infer<typeof agentContextModeSchema>;
      briefing?: string;
      includeParentTodos?: boolean;
      includeHarnessContext?: boolean;
      forkContext?: boolean;
    }) => {
      const normalizedMessage = message.trim();
      const normalizedRole = role ?? "default";
      const normalizedProfileRef = profileRef?.trim();
      const normalizedNickname = nickname?.trim();
      if (nickname !== undefined && !normalizedNickname) {
        throw new Error("spawnAgent nickname must not be empty");
      }
      const normalizedTargetPaths = normalizeAgentTargetPaths(targetPaths);
      if (normalizedTargetPaths !== undefined) {
        // An explicitly provided scope must be non-empty and fully valid; an
        // empty list would otherwise be treated as "no scope" and widen the child
        // to the whole workspace. Omit targetPaths entirely for whole-workspace.
        if (normalizedTargetPaths.length === 0) {
          throw new Error(
            "spawnAgent targetPaths must not be empty; omit it for whole-workspace scope.",
          );
        }
        // Reject the spawn if ANY entry is not a usable scope (outside the
        // workspace, an escaping symlink, or inside protected metadata like
        // `.git`/`.cowork`). The stored targetPaths feed both the OS sandbox and
        // the built-in file tools, so silently dropping invalid entries would let
        // a mixed scope (e.g. [".git/hooks", "src/ok"]) still write protected
        // metadata via write/edit. Children inherit the parent workspace.
        const invalid = normalizedTargetPaths.filter(
          (p) =>
            !isUsableTargetPath(
              ctx.config.workingDirectory,
              p,
              path.dirname(ctx.config.projectCoworkDir),
            ),
        );
        if (invalid.length > 0) {
          throw new Error(
            "spawnAgent targetPaths must be inside the workspace and outside .git/.cowork; " +
              `invalid: ${invalid.join(", ")}`,
          );
        }
      }
      const resolvedContext = resolveAgentSpawnContextOptions({
        contextMode,
        briefing,
        includeParentTodos,
        includeHarnessContext,
        forkContext,
      });
      if (!normalizedMessage) {
        throw new Error("spawnAgent message must not be empty");
      }
      ctx.log(
        `tool> spawnAgent ${JSON.stringify({
          role: normalizedRole,
          profileRef: normalizedProfileRef ?? null,
          hasModel: !!model,
          hasNickname: !!normalizedNickname,
          taskType: taskType ?? null,
          targetPathCount: normalizedTargetPaths?.length ?? 0,
          contextMode: resolvedContext.contextMode,
          hasBriefing: !!resolvedContext.briefing,
          includeParentTodos: resolvedContext.includeParentTodos,
          includeHarnessContext: resolvedContext.includeHarnessContext,
        })}`,
      );
      const result = await requireAgentControl(ctx).spawn({
        message: normalizedMessage,
        role: normalizedRole,
        ...(normalizedProfileRef ? { profileRef: normalizedProfileRef } : {}),
        ...(normalizedNickname ? { nickname: normalizedNickname } : {}),
        ...(taskType ? { taskType } : {}),
        ...(normalizedTargetPaths !== undefined ? { targetPaths: normalizedTargetPaths } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        contextMode: resolvedContext.contextMode,
        ...(resolvedContext.briefing ? { briefing: resolvedContext.briefing } : {}),
        ...(resolvedContext.includeParentTodos ? { includeParentTodos: true } : {}),
        ...(resolvedContext.includeHarnessContext ? { includeHarnessContext: true } : {}),
      });
      ctx.log(`tool< spawnAgent ${JSON.stringify({ agentId: result.agentId })}`);
      return result;
    },
  });
}
