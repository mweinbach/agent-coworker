import { z } from "zod";

import { AdvancedMemoryStore } from "../advancedMemoryStore";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

export function createRecallMemoryTool(ctx: ToolContext) {
  const store = AdvancedMemoryStore.fromConfig(ctx.config);
  return defineTool({
    description:
      "Read one advanced memory Markdown file by file name from the current memory index. Use only names listed in MEMORY.md.",
    inputSchema: z.object({
      name: z.string().trim().min(1).describe("Memory file name, with or without .md"),
    }),
    execute: async ({ name }: { name: string }) => {
      ctx.log(`tool> recallMemory ${JSON.stringify({ name })}`);
      if (!(ctx.config.enableMemory ?? true) || !(ctx.config.advancedMemory ?? false)) {
        return "Advanced memory is disabled for this workspace.";
      }
      const entry = await store.read(name);
      if (!entry) return `Advanced memory "${name}" was not found.`;
      ctx.log(
        `tool< recallMemory ${JSON.stringify({ fileName: entry.fileName, chars: entry.content.length })}`,
      );
      return entry.content;
    },
  });
}
