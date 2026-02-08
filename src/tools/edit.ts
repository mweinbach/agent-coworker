import fs from "node:fs/promises";

import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";
import { resolveMaybeRelative } from "../utils/paths";
import { isWritePathAllowed } from "../utils/permissions";

export function createEditTool(ctx: ToolContext) {
  return tool({
    description:
      "Replace exact text in a file. The oldString must exist and be unique unless replaceAll is true.",
    inputSchema: z.object({
      filePath: z.string().describe("Path to the file (prefer absolute)"),
      oldString: z.string().describe("Exact text to replace"),
      newString: z.string().describe("Replacement text"),
      replaceAll: z.boolean().optional().default(false).describe("Replace all occurrences"),
    }),
    execute: async ({ filePath, oldString, newString, replaceAll }) => {
      ctx.log(`tool> edit ${JSON.stringify({ filePath, replaceAll })}`);

      const abs = resolveMaybeRelative(filePath, ctx.config.workingDirectory);
      if (!isWritePathAllowed(abs, ctx.config)) {
        throw new Error(
          `Edit blocked: path is outside workingDirectory/outputDirectory: ${abs}`
        );
      }
      let content = await fs.readFile(abs, "utf-8");
      if (!content.includes(oldString)) throw new Error(`oldString not found in ${abs}`);

      if (!replaceAll) {
        const count = content.split(oldString).length - 1;
        if (count > 1) {
          throw new Error(
            `oldString found ${count} times in ${abs}. Provide more context or set replaceAll=true.`
          );
        }
      }

      content = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
      await fs.writeFile(abs, content, "utf-8");

      ctx.log(`tool< edit ${JSON.stringify({ ok: true })}`);
      return "Edit applied.";
    },
  });
}
