import fs from "node:fs/promises";

import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";
import { resolveMaybeRelative, truncateLine } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";

export function createReadTool(ctx: ToolContext) {
  return tool({
    description:
      "Read a file from the filesystem. Returns content with line numbers. Use offset/limit for large files.",
    inputSchema: z.object({
      filePath: z.string().describe("Path to the file (prefer absolute)"),
      offset: z.number().int().min(1).optional().describe("Start line (1-indexed)"),
      limit: z.number().int().min(1).max(20000).optional().default(2000).describe("Max lines"),
    }),
    execute: async ({ filePath, offset, limit }) => {
      ctx.log(`tool> read ${JSON.stringify({ filePath, offset, limit })}`);

      const abs = await assertReadPathAllowed(
        resolveMaybeRelative(filePath, ctx.config.workingDirectory),
        ctx.config,
        "read"
      );
      const raw = await fs.readFile(abs, "utf-8");
      const lines = raw.split("\n");
      const start = (offset || 1) - 1;
      const sliced = lines.slice(start, start + limit);
      const numbered = sliced.map((line, i) => `${start + i + 1}\t${truncateLine(line, 2000)}`);
      const res = numbered.join("\n");

      ctx.log(`tool< read ${JSON.stringify({ chars: res.length })}`);
      return res;
    },
  });
}
