import { z } from "zod";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

function requireAgentControl(ctx: ToolContext) {
  if (!ctx.agentControl) {
    throw new Error("Child agents are unavailable outside a session-backed turn.");
  }
  return ctx.agentControl;
}

export function createListAgentsTool(ctx: ToolContext) {
  return defineTool({
    description: "List collaborative child agents for the current parent session.",
    inputSchema: z.object({}).strict(),
    execute: async () => await requireAgentControl(ctx).list(),
  });
}

export function createSendAgentInputTool(ctx: ToolContext) {
  return defineTool({
    description: "Send a follow-up message to an existing child agent. Use interrupt=true to redirect work immediately.",
    inputSchema: z.object({
      agentId: z.string().trim().min(1),
      message: z.string().trim().min(1).max(20_000),
      interrupt: z.boolean().optional(),
    }),
    execute: async ({ agentId, message, interrupt }: { agentId: string; message: string; interrupt?: boolean }) => {
      ctx.log(`tool> sendAgentInput ${JSON.stringify({ agentId, interrupt: interrupt === true })}`);
      await requireAgentControl(ctx).sendInput({ agentId, message, interrupt });
      ctx.log(`tool< sendAgentInput ${JSON.stringify({ agentId })}`);
      return { agentId, queued: true };
    },
  });
}

export function createWaitForAgentTool(ctx: ToolContext) {
  return defineTool({
    description: "Wait for one or more child agents to reach a terminal state. Returns empty status when timed out.",
    inputSchema: z.object({
      agentIds: z.array(z.string().trim().min(1)).min(1),
      timeoutMs: z.number().int().min(1).max(300_000).optional(),
    }),
    execute: async ({ agentIds, timeoutMs }: { agentIds: string[]; timeoutMs?: number }) =>
      await requireAgentControl(ctx).wait({ agentIds, timeoutMs }),
  });
}

export function createInspectAgentTool(ctx: ToolContext) {
  return defineTool({
    description: "Read the latest detailed result for a child agent, including full assistant text and parsed structured report.",
    inputSchema: z.object({
      agentId: z.string().trim().min(1),
    }),
    execute: async ({ agentId }: { agentId: string }) => {
      ctx.log(`tool> inspectAgent ${JSON.stringify({ agentId })}`);
      const result = await requireAgentControl(ctx).inspect({ agentId });
      ctx.log(`tool< inspectAgent ${JSON.stringify({ agentId, hasText: !!result.latestAssistantText, hasReport: !!result.parsedReport })}`);
      return result;
    },
  });
}

export function createResumeAgentTool(ctx: ToolContext) {
  return defineTool({
    description: "Resume a previously closed child agent by id so it can receive new input and waits.",
    inputSchema: z.object({
      agentId: z.string().trim().min(1),
    }),
    execute: async ({ agentId }: { agentId: string }) => {
      ctx.log(`tool> resumeAgent ${JSON.stringify({ agentId })}`);
      const result = await requireAgentControl(ctx).resume({ agentId });
      ctx.log(`tool< resumeAgent ${JSON.stringify({ agentId })}`);
      return result;
    },
  });
}

export function createCloseAgentTool(ctx: ToolContext) {
  return defineTool({
    description: "Close a child agent when it is no longer needed and return its last known status.",
    inputSchema: z.object({
      agentId: z.string().trim().min(1),
    }),
    execute: async ({ agentId }: { agentId: string }) => {
      ctx.log(`tool> closeAgent ${JSON.stringify({ agentId })}`);
      const result = await requireAgentControl(ctx).close({ agentId });
      ctx.log(`tool< closeAgent ${JSON.stringify({ agentId })}`);
      return result;
    },
  });
}
