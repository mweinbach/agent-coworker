import { z } from "zod";

import { serializeTurnDelta } from "../advancedMemory/MemoryGenerator";
import { getAiCoworkerPaths } from "../store/connections";
import {
  listPersistedSessionSnapshots,
  readPersistedSessionSnapshot,
} from "../server/sessionStore";
import type { ModelMessage } from "../types";
import { truncateText } from "../utils/paths";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

/**
 * Lets the main agent revisit prior sessions: list recent conversations or read
 * a specific transcript by sessionId (tool outputs truncated for frugality).
 * Memory entries record their `originSessionId`, which feeds this tool.
 */
export function createReadPastConversationTool(ctx: ToolContext) {
  const paths = getAiCoworkerPaths();

  return defineTool({
    description: `Read a prior conversation transcript by sessionId, or list recent sessions. Memory entries reference their originSessionId, which you can pass here.`,
    inputSchema: z.object({
      sessionId: z.string().optional().describe("Session id to read; omit with list:true to browse"),
      list: z.boolean().optional().describe("List recent sessions instead of reading one"),
      limit: z.number().int().positive().max(50).optional().describe("Max sessions to list"),
    }),
    execute: async ({
      sessionId,
      list,
      limit,
    }: {
      sessionId?: string;
      list?: boolean;
      limit?: number;
    }) => {
      ctx.log(`tool> readPastConversation ${JSON.stringify({ sessionId, list, limit })}`);

      if (list || !sessionId) {
        const summaries = await listPersistedSessionSnapshots(paths);
        const top = summaries.slice(0, limit ?? 20);
        if (top.length === 0) return "No past conversations found.";
        return top
          .map(
            (s) =>
              `- ${s.sessionId} — ${s.title || "(untitled)"} (${s.messageCount} msgs, updated ${s.updatedAt})`,
          )
          .join("\n");
      }

      const snapshot = await readPersistedSessionSnapshot({ paths, sessionId });
      if (!snapshot) return `No conversation found for sessionId "${sessionId}".`;
      const transcript = serializeTurnDelta(snapshot.context.messages as ModelMessage[]);
      const header = `# ${snapshot.session.title || "(untitled)"}\nsessionId: ${snapshot.sessionId}\n\n`;
      return truncateText(`${header}${transcript}`, 30000);
    },
  });
}
