import { z } from "zod";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

export function createReadPastConversationTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Read a prior session transcript by sessionId. Use when the user asks about a previous conversation or a memory index references one.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(200).optional().default(80),
    }),
    execute: async ({
      sessionId,
      offset,
      limit,
    }: {
      sessionId: string;
      offset?: number;
      limit: number;
    }) => {
      ctx.log(`tool> readPastConversation ${JSON.stringify({ sessionId, offset, limit })}`);
      if (!(ctx.config.enableMemory ?? true) || !(ctx.config.advancedMemory ?? false)) {
        return "Advanced memory is disabled for this workspace.";
      }
      if (!ctx.readPastConversation) {
        return "Past conversation transcripts are unavailable in this session.";
      }
      const transcript = await ctx.readPastConversation({ sessionId, offset, limit });
      ctx.log(`tool< readPastConversation ${JSON.stringify({ chars: transcript.length })}`);
      return transcript;
    },
  });
}
