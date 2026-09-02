import { z } from "zod";
import { resolveMaybeRelative } from "../utils/paths";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { withFileMutation } from "./mutationGuard";

export function createWriteTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Write content to a file. Creates parent directories if needed. Overwrites existing files by default, or appends when mode is append.",
    inputSchema: z.object({
      filePath: z.string().min(1).describe("Path to write (prefer absolute)"),
      content: z.string().max(2_000_000).describe("Content to write"),
      mode: z
        .enum(["overwrite", "append"])
        .optional()
        .default("overwrite")
        .describe("Use overwrite for a full replacement, or append to add a chunk"),
    }),
    execute: async ({
      filePath,
      content,
      mode,
    }: {
      filePath: string;
      content: string;
      mode?: "overwrite" | "append";
    }) => {
      const resolvedMode = mode ?? "overwrite";
      ctx.log(
        `tool> write ${JSON.stringify({ filePath, chars: content.length, mode: resolvedMode })}`,
      );
      const abs = resolveMaybeRelative(filePath, ctx.config.workingDirectory);
      await withFileMutation(ctx, "write", abs, (file) =>
        file.commit(content, { append: resolvedMode === "append" }),
      );

      const verb = resolvedMode === "append" ? "Appended" : "Wrote";
      const res = `${verb} ${content.length} chars to ${abs}`;
      ctx.log(`tool< write ${JSON.stringify({ ok: true })}`);
      return res;
    },
  });
}
