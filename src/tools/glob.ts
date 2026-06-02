import path from "node:path";
import fg from "fast-glob";

import { z } from "zod";
import { resolveMaybeRelative } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const globInputSchema = z
  .object({
    pattern: z.string().describe("Glob pattern to match (e.g. **/*.ts)"),
    cwd: z.string().optional().describe("Directory to search from (defaults to working directory)"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .default(2000)
      .describe("Maximum files to return"),
  })
  .strict();
const globEntrySchema = z.union([
  z.string(),
  z
    .object({
      path: z.string(),
      stats: z
        .object({
          mtimeMs: z.number().finite().optional(),
        })
        .optional(),
    })
    .passthrough(),
]);
function assertSafeGlobPattern(pattern: string): void {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const maybeNegatedPattern = normalizedPattern.startsWith("!")
    ? normalizedPattern.slice(1)
    : normalizedPattern;

  if (path.isAbsolute(maybeNegatedPattern) || /^[A-Za-z]:[/\\]/.test(maybeNegatedPattern)) {
    throw new Error("glob blocked: pattern must be relative to cwd");
  }

  if (/^\.\.(\/|$)/.test(maybeNegatedPattern) || maybeNegatedPattern.includes("/../")) {
    throw new Error("glob blocked: pattern cannot escape cwd");
  }
}

export function createGlobTool(ctx: ToolContext) {
  return defineTool({
    description: "Find files matching a glob pattern. Returns paths sorted by modification time.",
    inputSchema: globInputSchema,
    execute: async ({ pattern, cwd, maxResults }: z.infer<typeof globInputSchema>) => {
      const parsedInput = globInputSchema.safeParse({ pattern, cwd, maxResults });
      if (!parsedInput.success) {
        throw new Error(
          `glob invalid input: ${parsedInput.error.issues[0]?.message ?? "validation_failed"}`,
        );
      }
      const normalizedInput = parsedInput.data;
      ctx.log(`tool> glob ${JSON.stringify(normalizedInput)}`);
      const effectiveMaxResults = normalizedInput.maxResults;

      let normalizedPattern = normalizedInput.pattern.replace(/\\/g, "/");
      let effectiveCwd = normalizedInput.cwd;

      const isAbsolutePattern =
        path.isAbsolute(normalizedPattern) || /^[A-Za-z]:[/\\]/.test(normalizedPattern);
      if (isAbsolutePattern) {
        const firstGlobIndex = normalizedPattern.search(/[*?[{]/);
        const staticPrefix =
          firstGlobIndex === -1 ? normalizedPattern : normalizedPattern.slice(0, firstGlobIndex);
        const lastSlash = staticPrefix.lastIndexOf("/");
        if (lastSlash !== -1) {
          effectiveCwd = staticPrefix.slice(0, lastSlash) || "/";
          normalizedPattern = normalizedPattern.slice(lastSlash + 1);
        }
      }

      assertSafeGlobPattern(normalizedPattern);

      const searchCwd = await assertReadPathAllowed(
        resolveMaybeRelative(
          effectiveCwd || ctx.config.workingDirectory,
          ctx.config.workingDirectory,
        ),
        ctx.config,
        "glob",
        ctx.agentTargetPaths,
      );
      const files: Array<{ path: string; mtimeMs: number }> = [];
      let seen = 0;
      const keepNewestCandidate = (candidate: { path: string; mtimeMs: number }) => {
        seen += 1;
        files.push(candidate);
        if (files.length > effectiveMaxResults * 2) {
          files.sort((a, b) => b.mtimeMs - a.mtimeMs);
          files.length = effectiveMaxResults;
        }
      };
      const stream = fg.stream(normalizedPattern, {
        cwd: searchCwd,
        dot: false,
        objectMode: true,
        stats: true,
        braceExpansion: false,
        followSymbolicLinks: false,
      });
      for await (const entry of stream as AsyncIterable<unknown>) {
        if (ctx.abortSignal?.aborted) throw new Error("Cancelled by user");
        const parsedEntry = globEntrySchema.safeParse(entry);
        if (!parsedEntry.success) continue;

        const relativePath =
          typeof parsedEntry.data === "string" ? parsedEntry.data : parsedEntry.data.path;
        const absoluteMatchPath = path.resolve(searchCwd, relativePath);
        await assertReadPathAllowed(absoluteMatchPath, ctx.config, "glob", ctx.agentTargetPaths);

        if (typeof parsedEntry.data === "string") {
          keepNewestCandidate({ path: parsedEntry.data, mtimeMs: 0 });
        } else {
          keepNewestCandidate({
            path: parsedEntry.data.path,
            mtimeMs: parsedEntry.data.stats?.mtimeMs ?? 0,
          });
        }
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      files.length = Math.min(files.length, effectiveMaxResults);
      const truncated = seen > effectiveMaxResults;

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
