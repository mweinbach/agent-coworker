import { z } from "zod";

import { AGENT_ROLE_VALUES, agentReasoningEffortSchema } from "../shared/agents";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

function requireAgentControl(ctx: ToolContext) {
  if (!ctx.agentControl) {
    throw new Error("Child agents are unavailable outside a session-backed turn.");
  }
  return ctx.agentControl;
}

export function createSpawnAgentTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Spawn a collaborative child agent for a well-scoped task. The optional model override may be a same-provider model id or a provider:modelId child target ref. Returns the child handle to use with sendAgentInput, waitForAgent, inspectAgent, resumeAgent, and closeAgent.",
    inputSchema: z.object({
      message: z.string().trim().min(1).max(20_000),
      role: z.enum(AGENT_ROLE_VALUES).optional().default("default"),
      model: z.string().trim().min(1).optional(),
      reasoningEffort: agentReasoningEffortSchema.optional(),
      forkContext: z.boolean().optional(),
    }),
    execute: async ({
      message,
      role,
      model,
      reasoningEffort,
      forkContext,
    }: {
      message: string;
      role?: (typeof AGENT_ROLE_VALUES)[number];
      model?: string;
      reasoningEffort?: z.infer<typeof agentReasoningEffortSchema>;
      forkContext?: boolean;
    }) => {
      const normalizedMessage = message.trim();
      const normalizedRole = role ?? "default";
      if (!normalizedMessage) {
        throw new Error("spawnAgent message must not be empty");
      }
      ctx.log(`tool> spawnAgent ${JSON.stringify({ role: normalizedRole, hasModel: !!model, forkContext: forkContext === true })}`);
      const result = await requireAgentControl(ctx).spawn({
        message: normalizedMessage,
        role: normalizedRole,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(forkContext !== undefined ? { forkContext } : {}),
      });
      ctx.log(`tool< spawnAgent ${JSON.stringify({ agentId: result.agentId })}`);
      return result;
    },
  });
}
