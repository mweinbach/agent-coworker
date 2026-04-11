import { z } from "zod";

import {
  AGENT_ROLE_VALUES,
  agentContextModeSchema,
  agentReasoningEffortSchema,
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
  const inputSchema = z.object({
    message: z.string().trim().min(1).max(20_000),
    role: z.enum(AGENT_ROLE_VALUES).optional().default("default"),
    model: z.string().trim().min(1).optional(),
    reasoningEffort: agentReasoningEffortSchema.optional(),
    contextMode: agentContextModeSchema.optional(),
    briefing: z.string().trim().min(1).max(20_000).optional(),
    includeParentTodos: z.boolean().optional(),
    includeHarnessContext: z.boolean().optional(),
  }).superRefine((value, issueContext) => {
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
      "Spawn a collaborative child agent for a well-scoped task. Use contextMode='brief' with an explicit briefing for a cheap handoff, or contextMode='full' only when the child truly needs the full parent transcript. The optional model override may be a same-provider model id or a provider:modelId child target ref. Returns the child handle to use with sendAgentInput, waitForAgent, inspectAgent, resumeAgent, and closeAgent.",
    inputSchema,
    execute: async ({
      message,
      role,
      model,
      reasoningEffort,
      contextMode,
      briefing,
      includeParentTodos,
      includeHarnessContext,
      forkContext,
    }: {
      message: string;
      role?: (typeof AGENT_ROLE_VALUES)[number];
      model?: string;
      reasoningEffort?: z.infer<typeof agentReasoningEffortSchema>;
      contextMode?: z.infer<typeof agentContextModeSchema>;
      briefing?: string;
      includeParentTodos?: boolean;
      includeHarnessContext?: boolean;
      forkContext?: boolean;
    }) => {
      const normalizedMessage = message.trim();
      const normalizedRole = role ?? "default";
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
          hasModel: !!model,
          contextMode: resolvedContext.contextMode,
          hasBriefing: !!resolvedContext.briefing,
          includeParentTodos: resolvedContext.includeParentTodos,
          includeHarnessContext: resolvedContext.includeHarnessContext,
        })}`,
      );
      const result = await requireAgentControl(ctx).spawn({
        message: normalizedMessage,
        role: normalizedRole,
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
