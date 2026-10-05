import { z } from "zod";

import {
  AdvancedMemoryStore,
  CHATS_FOLDER,
  resolveMemoriesDir,
  resolveMemoryFolderName,
} from "../advancedMemory/store";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { findByNameOrSlug } from "./manageMemory";

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
          `Memory folder to read from. Only the active folder or ${CHATS_FOLDER} are available; omit to search both.`,
        ),
    }),
    execute: async ({ name, folder }: { name: string; folder?: string }) => {
      ctx.log(`tool> recallMemory ${JSON.stringify({ name, folder })}`);
      const requestedFolder = folder?.trim();
      const allowedFolders = new Set([activeFolder, CHATS_FOLDER]);
      if (requestedFolder && !allowedFolders.has(requestedFolder)) {
        ctx.log(
          `tool< recallMemory ${JSON.stringify({ ok: false, reason: "folder_unavailable" })}`,
        );
        return `Memory folder "${requestedFolder}" is not available in this session.`;
      }
      const folders = requestedFolder
        ? [requestedFolder]
        : activeFolder === CHATS_FOLDER
          ? [CHATS_FOLDER]
          : [activeFolder, CHATS_FOLDER];
      const match = await findByNameOrSlug(store, folders, name);
      if (!match) {
        ctx.log(`tool< recallMemory ${JSON.stringify({ ok: false, reason: "not_found" })}`);
        return `No memory named "${name}" found.`;
      }
      const { entry } = match;
      const out = [
        `# ${entry.name}`,
        entry.description ? `\n${entry.description}\n` : "",
        entry.body,
      ]
        .filter(Boolean)
        .join("\n");
      ctx.log(
        `tool< recallMemory ${JSON.stringify({ ok: true, folder: match.folder, chars: out.length })}`,
      );
      return out;
    },
  });
}
