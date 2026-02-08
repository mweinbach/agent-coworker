import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";

export function createAskTool(ctx: ToolContext) {
  return tool({
    description:
      "Ask the user a clarifying question. Provide options when possible. Returns the user's answer.",
    inputSchema: z.object({
      question: z.string().describe("The question to ask"),
      options: z.array(z.string()).optional().describe("Multiple-choice options"),
    }),
    execute: async ({ question, options }) => {
      ctx.log(`tool> ask ${JSON.stringify({ question, options })}`);
      const answer = await ctx.askUser(question, options);
      ctx.log(`tool< ask ${JSON.stringify({ answer })}`);
      return answer;
    },
  });
}
