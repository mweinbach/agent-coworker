import { z } from "zod";

import {
  AdvancedMemoryStore,
  CHATS_FOLDER,
  resolveMemoriesDir,
  resolveMemoryFolderName,
} from "../advancedMemory/store";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

/**
 * Lets the main agent read the full content of an advanced (file-based) memory
 * by name. The memory index (names + descriptions) is injected into the system
 * prompt; this tool fetches the body of a chosen entry.
 */
export function createRecallMemoryTool(ctx: ToolContext) {
  const store = new AdvancedMemoryStore(resolveMemoriesDir(ctx.config));
  const activeFolder = resolveMemoryFolderName(ctx.config);

  return defineTool({
    description: `Read the full content of a long-term memory by name/slug. Names are listed in the Memory Index in your system prompt. Searches the active folder, then the shared ${CHATS_FOLDER} folder.`,
    inputSchema: z.object({
      name: z.string().describe("Memory name or slug, as shown in the Memory Index"),
      folder: z
        .string()
        .optional()
        .describe(
          `Memory folder to read from (defaults to the active folder, then ${CHATS_FOLDER})`,
        ),
    }),
    execute: async ({ name, folder }: { name: string; folder?: string }) => {
      ctx.log(`tool> recallMemory ${JSON.stringify({ name, folder })}`);
      const folders = folder
        ? [folder]
        : activeFolder === CHATS_FOLDER
          ? [CHATS_FOLDER]
          : [activeFolder, CHATS_FOLDER];
      for (const candidate of folders) {
        const entry = await store.readMemory(candidate, name);
        if (entry) {
          return [
            `# ${entry.name}`,
            entry.description ? `\n${entry.description}\n` : "",
            entry.body,
          ]
            .filter(Boolean)
            .join("\n");
        }
      }
      return `No memory named "${name}" found.`;
    },
  });
}
