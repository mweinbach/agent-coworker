import path from "node:path";

import { z } from "zod";

import { defaultLocalToolExecutionBackend } from "../execution/local";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { resolveMaybeRelative } from "../utils/paths";
import { assertWritePathAllowed } from "../utils/permissions";

export function createWriteTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
    inputSchema: z.object({
      filePath: z.string().min(1).describe("Path to write (prefer absolute)"),
      content: z.string().max(2_000_000).describe("Content to write"),
    }),
    execute: async ({ filePath, content }: { filePath: string; content: string }) => {
      ctx.log(`tool> write ${JSON.stringify({ filePath, chars: content.length })}`);

      const abs = await assertWritePathAllowed(
        resolveMaybeRelative(filePath, ctx.config.workingDirectory),
        ctx.config,
        "write"
      );
      const executionBackend = ctx.executionBackend ?? defaultLocalToolExecutionBackend;
      await executionBackend.makeDirectory({ dirPath: path.dirname(abs) });
      await executionBackend.writeTextFile({ filePath: abs, content });

      const res = `Wrote ${content.length} chars to ${abs}`;
      ctx.log(`tool< write ${JSON.stringify({ ok: true })}`);
      return res;
    },
  });
}
