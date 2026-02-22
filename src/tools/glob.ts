import fg from "fast-glob";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";
import { resolveMaybeRelative } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";

const globInputSchema = z.object({
  pattern: z.string().describe("Glob pattern to match (e.g. **/*.ts)"),
  cwd: z.string().optional().describe("Directory to search from (defaults to working directory)"),
  maxResults: z.number().int().min(1).max(10000).optional().default(2000).describe("Maximum files to return"),
}).strict();
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
  return tool({
    description: "Find files matching a glob pattern. Returns paths sorted by modification time.",
    inputSchema: globInputSchema,
    execute: async ({ pattern, cwd, maxResults }) => {
      const parsedInput = globInputSchema.safeParse({ pattern, cwd, maxResults });
      if (!parsedInput.success) {
        throw new Error(`glob invalid input: ${parsedInput.error.issues[0]?.message ?? "validation_failed"}`);
      }
      const normalizedInput = parsedInput.data;
      ctx.log(`tool> glob ${JSON.stringify(normalizedInput)}`);
      const effectiveMaxResults = normalizedInput.maxResults;

      assertSafeGlobPattern(normalizedInput.pattern);

      const searchCwd = await assertReadPathAllowed(
        resolveMaybeRelative(normalizedInput.cwd || ctx.config.workingDirectory, ctx.config.workingDirectory),
        ctx.config,
        "glob"
      );
      const files: Array<{ path: string; mtimeMs: number }> = [];
      const stream = fg.stream(normalizedInput.pattern, {
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
