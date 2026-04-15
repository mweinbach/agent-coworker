import { z } from "zod";

import { defaultLocalToolExecutionBackend } from "../execution/local";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { resolveMaybeRelative } from "../utils/paths";
import { assertWritePathAllowed } from "../utils/permissions";

export function createEditTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Replace exact text in a file. The oldString must exist and be unique unless replaceAll is true.",
    inputSchema: z.object({
      filePath: z.string().min(1).describe("Path to the file (prefer absolute)"),
      oldString: z.string().min(1).describe("Exact text to replace"),
      newString: z.string().describe("Replacement text"),
      replaceAll: z.boolean().optional().default(false).describe("Replace all occurrences"),
    }),
    execute: async ({
      filePath,
      oldString,
      newString,
      replaceAll,
    }: {
      filePath: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }) => {
      ctx.log(`tool> edit ${JSON.stringify({ filePath, replaceAll })}`);
      if (oldString === "") throw new Error("oldString cannot be empty");

      const abs = await assertWritePathAllowed(
        resolveMaybeRelative(filePath, ctx.config.workingDirectory),
        ctx.config,
        "edit"
      );
      const executionBackend = ctx.executionBackend ?? defaultLocalToolExecutionBackend;
      let content = await executionBackend.readTextFile({ filePath: abs });
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
      await executionBackend.writeTextFile({ filePath: abs, content });

      ctx.log(`tool< edit ${JSON.stringify({ ok: true })}`);
      return "Edit applied.";
    },
  });
}
