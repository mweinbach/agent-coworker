import fg from "fast-glob";

import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";
import { resolveMaybeRelative } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";

export function createGlobTool(ctx: ToolContext) {
  return tool({
    description: "Find files matching a glob pattern. Returns paths sorted by modification time.",
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern to match (e.g. **/*.ts)"),
      cwd: z.string().optional().describe("Directory to search from (defaults to working directory)"),
    }),
    execute: async ({ pattern, cwd }) => {
      ctx.log(`tool> glob ${JSON.stringify({ pattern, cwd })}`);

      const searchCwd = await assertReadPathAllowed(
        resolveMaybeRelative(cwd || ctx.config.workingDirectory, ctx.config.workingDirectory),
        ctx.config,
        "glob"
      );
      const files = await fg(pattern, {
        cwd: searchCwd,
        dot: false,
        stats: true,
        followSymbolicLinks: false,
      });
      files.sort((a, b) => (b.stats?.mtimeMs || 0) - (a.stats?.mtimeMs || 0));

      const res = files.map((f) => f.path).join("\n") || "No files found.";
      ctx.log(`tool< glob ${JSON.stringify({ count: files.length })}`);
      return res;
    },
  });
}
