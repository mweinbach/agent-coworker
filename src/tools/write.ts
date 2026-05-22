import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";
import { resolveMaybeRelative } from "../utils/paths";
import { assertWritePathAllowed } from "../utils/permissions";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

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

      const abs = await assertWritePathAllowed(
        resolveMaybeRelative(filePath, ctx.config.workingDirectory),
        ctx.config,
        "write",
      );
      await fs.mkdir(path.dirname(abs), { recursive: true });
      if (resolvedMode === "append") {
        await fs.appendFile(abs, content, "utf-8");
      } else {
        await fs.writeFile(abs, content, "utf-8");
      }

      const verb = resolvedMode === "append" ? "Appended" : "Wrote";
      const res = `${verb} ${content.length} chars to ${abs}`;
      ctx.log(`tool< write ${JSON.stringify({ ok: true })}`);
      return res;
    },
  });
}
