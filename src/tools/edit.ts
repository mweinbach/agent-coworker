import fs from "node:fs/promises";

import { Type } from "@mariozechner/pi-ai";

import { toAgentTool } from "../pi/toolAdapter";
import type { ToolContext } from "./context";
import { resolveMaybeRelative } from "../utils/paths";
import { assertWritePathAllowed } from "../utils/permissions";

export function createEditTool(ctx: ToolContext) {
  return toAgentTool({
    name: "edit",
    description:
      "Replace exact text in a file. The oldString must exist and be unique unless replaceAll is true.",
    parameters: Type.Object({
      filePath: Type.String({ description: "Path to the file (prefer absolute)", minLength: 1 }),
      oldString: Type.String({ description: "Exact text to replace", minLength: 1 }),
      newString: Type.String({ description: "Replacement text" }),
      replaceAll: Type.Optional(Type.Boolean({ description: "Replace all occurrences", default: false })),
    }),
    execute: async ({ filePath, oldString, newString, replaceAll: rawReplaceAll }) => {
      const replaceAll = rawReplaceAll ?? false;
      ctx.log(`tool> edit ${JSON.stringify({ filePath, replaceAll })}`);
      if (oldString === "") throw new Error("oldString cannot be empty");

      const abs = await assertWritePathAllowed(
        resolveMaybeRelative(filePath, ctx.config.workingDirectory),
        ctx.config,
        "edit"
      );
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
