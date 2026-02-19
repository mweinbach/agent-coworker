import fg from "fast-glob";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";
import { resolveMaybeRelative } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";

function assertSafeGlobPattern(pattern: string): void {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const maybeNegatedPattern = normalizedPattern.startsWith("!") ? normalizedPattern.slice(1) : normalizedPattern;

  if (path.isAbsolute(maybeNegatedPattern) || /^[A-Za-z]:\//.test(maybeNegatedPattern)) {
    throw new Error("glob blocked: pattern must be relative to cwd");
  }

  if (/^\.\.(\/|$)/.test(maybeNegatedPattern) || maybeNegatedPattern.includes("/../")) {
    throw new Error("glob blocked: pattern cannot escape cwd");
  }
}

export function createGlobTool(ctx: ToolContext) {
  return tool({
    description: "Find files matching a glob pattern. Returns paths sorted by modification time.",
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern to match (e.g. **/*.ts)"),
      cwd: z.string().optional().describe("Directory to search from (defaults to working directory)"),
      maxResults: z.number().int().min(1).max(10000).optional().default(2000).describe("Maximum files to return"),
    }),
    execute: async ({ pattern, cwd, maxResults }) => {
      ctx.log(`tool> glob ${JSON.stringify({ pattern, cwd, maxResults })}`);
      const effectiveMaxResults = Number.isInteger(maxResults) && (maxResults as number) > 0 ? (maxResults as number) : 2000;

      assertSafeGlobPattern(pattern);

      const searchCwd = await assertReadPathAllowed(
        resolveMaybeRelative(cwd || ctx.config.workingDirectory, ctx.config.workingDirectory),
        ctx.config,
        "glob"
      );
      const files: Array<{ path: string; mtimeMs: number }> = [];
      const stream = fg.stream(pattern, {
        cwd: searchCwd,
        dot: false,
        objectMode: true,
        stats: true,
        braceExpansion: false,
        followSymbolicLinks: false,
      });
      let truncated = false;
      for await (const entry of stream as AsyncIterable<unknown>) {
        if (ctx.abortSignal?.aborted) throw new Error("Cancelled by user");
        if (typeof entry === "string") {
          files.push({ path: entry, mtimeMs: 0 });
        } else if (entry && typeof entry === "object") {
          const maybePath = (entry as any).path;
          if (typeof maybePath !== "string") continue;
          const mtimeMs = typeof (entry as any).stats?.mtimeMs === "number" ? (entry as any).stats.mtimeMs : 0;
          files.push({ path: maybePath, mtimeMs });
        }

        if (files.length >= effectiveMaxResults) {
          truncated = true;
          (stream as any).destroy?.();
          break;
        }
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);

      await Promise.all(
        files.map(async (f) => {
          const absoluteMatchPath = path.resolve(searchCwd, f.path);
          await assertReadPathAllowed(absoluteMatchPath, ctx.config, "glob");
        })
      );

      const listed = files.map((f) => f.path).join("\n");
      const res = listed
        ? truncated
          ? `${listed}\n... truncated to ${effectiveMaxResults} matches`
          : listed
        : "No files found.";
      ctx.log(`tool< glob ${JSON.stringify({ count: files.length, truncated })}`);
      return res;
    },
  });
}
