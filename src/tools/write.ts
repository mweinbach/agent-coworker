import fs from "node:fs/promises";
import path from "node:path";

import { Type } from "@mariozechner/pi-ai";

import { toAgentTool } from "../pi/toolAdapter";
import type { ToolContext } from "./context";
import { resolveMaybeRelative } from "../utils/paths";
import { assertWritePathAllowed } from "../utils/permissions";

export function createWriteTool(ctx: ToolContext) {
  return toAgentTool({
    name: "write",
    description:
      "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
    parameters: Type.Object({
      filePath: Type.String({ description: "Path to write (prefer absolute)", minLength: 1 }),
      content: Type.String({ description: "Content to write", maxLength: 2_000_000 }),
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
