import fs from "node:fs/promises";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";
import { resolveMaybeRelative } from "../utils/paths";
import { assertWritePathAllowed } from "../utils/permissions";

export function createWriteTool(ctx: ToolContext) {
  return tool({
    description:
      "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
    inputSchema: z.object({
      filePath: z.string().min(1).describe("Path to write (prefer absolute)"),
      content: z.string().max(2_000_000).describe("Content to write"),
    }),
    execute: async ({ filePath, content }) => {
      ctx.log(`tool> write ${JSON.stringify({ filePath, chars: content.length })}`);

      const abs = await assertWritePathAllowed(
        resolveMaybeRelative(filePath, ctx.config.workingDirectory),
        ctx.config,
        "write"
      );
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf-8");

      const res = `Wrote ${content.length} chars to ${abs}`;
      ctx.log(`tool< write ${JSON.stringify({ ok: true })}`);
      return res;
    },
  });
}
