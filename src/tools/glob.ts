import path from "node:path";

import { z } from "zod";

import { defaultLocalToolExecutionBackend } from "../execution/local";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { resolveMaybeRelative } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";

const globInputSchema = z.object({
  pattern: z.string().describe("Glob pattern to match (e.g. **/*.ts)"),
  cwd: z.string().optional().describe("Directory to search from (defaults to working directory)"),
  maxResults: z.number().int().min(1).max(10000).optional().default(2000).describe("Maximum files to return"),
}).strict();
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
  return defineTool({
    description: "Find files matching a glob pattern. Returns paths sorted by modification time.",
    inputSchema: globInputSchema,
    execute: async ({ pattern, cwd, maxResults }: z.infer<typeof globInputSchema>) => {
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
      const executionBackend = ctx.executionBackend ?? defaultLocalToolExecutionBackend;
      const { matches: files, truncated } = await executionBackend.glob({
        pattern: normalizedInput.pattern,
        cwd: searchCwd,
        maxResults: effectiveMaxResults,
        abortSignal: ctx.abortSignal,
      });

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
