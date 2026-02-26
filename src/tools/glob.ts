import fg from "fast-glob";
import path from "node:path";

import { Type } from "@mariozechner/pi-ai";
import { z } from "zod";

import { toAgentTool } from "../pi/toolAdapter";
import type { ToolContext } from "./context";
import { resolveMaybeRelative } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";

const globInputParameters = Type.Object({
  pattern: Type.String({ description: "Glob pattern to match (e.g. **/*.ts)" }),
  cwd: Type.Optional(Type.String({ description: "Directory to search from (defaults to working directory)" })),
  maxResults: Type.Optional(Type.Integer({ description: "Maximum files to return", minimum: 1, maximum: 10000, default: 2000 })),
});
const globEntrySchema = z.union([
  z.string(),
  z.object({
    path: z.string(),
    stats: z.object({
      mtimeMs: z.number().finite().optional(),
    }).optional(),
  }).passthrough(),
]);
const destroyableStreamSchema = z.object({
  destroy: z.unknown().optional(),
}).passthrough();

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
  return toAgentTool({
    name: "glob",
    description: "Find files matching a glob pattern. Returns paths sorted by modification time.",
    parameters: globInputParameters,
    execute: async ({ pattern, cwd, maxResults: rawMaxResults }) => {
      const effectiveMaxResults = rawMaxResults ?? 2000;
      ctx.log(`tool> glob ${JSON.stringify({ pattern, cwd, maxResults: effectiveMaxResults })}`);

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
        const parsedEntry = globEntrySchema.safeParse(entry);
        if (!parsedEntry.success) continue;

        if (typeof parsedEntry.data === "string") {
          files.push({ path: parsedEntry.data, mtimeMs: 0 });
        } else {
          files.push({
            path: parsedEntry.data.path,
            mtimeMs: parsedEntry.data.stats?.mtimeMs ?? 0,
          });
        }

        if (files.length >= effectiveMaxResults) {
          truncated = true;
          const destroyableStream = destroyableStreamSchema.safeParse(stream);
          if (destroyableStream.success && typeof destroyableStream.data.destroy === "function") {
            destroyableStream.data.destroy?.();
          }
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
