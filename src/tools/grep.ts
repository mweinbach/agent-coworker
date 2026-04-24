import { execFile } from "node:child_process";
import { z } from "zod";
import { resolveCoworkHomedir } from "../utils/coworkHome";
import { resolveMaybeRelative } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";
import { ensureRipgrep } from "../utils/ripgrep";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const errorCodeSchema = z.object({ code: z.union([z.string(), z.number()]) }).passthrough();

export function createGrepTool(
  ctx: ToolContext,
  opts: { execFileImpl?: typeof execFile; ensureRipgrepImpl?: typeof ensureRipgrep } = {},
) {
  const execFileImpl = opts.execFileImpl ?? execFile;
  const ensureRipgrepImpl = opts.ensureRipgrepImpl ?? ensureRipgrep;

  return defineTool({
    description:
      "Search file contents for a regex pattern using ripgrep (rg). Returns matching lines with filenames and line numbers. If rg is missing, Cowork will auto-download it.",
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern"),
      path: z.string().optional().describe("File or directory to search"),
      fileGlob: z.string().optional().describe("Glob to filter files (e.g. *.ts)"),
      contextLines: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("Context lines around matches"),
      caseSensitive: z.boolean().optional().default(true),
    }),
    execute: async ({
      pattern,
      path: searchPath,
      fileGlob,
      contextLines,
      caseSensitive,
    }: {
      pattern: string;
      path?: string;
      fileGlob?: string;
      contextLines?: number;
      caseSensitive: boolean;
    }) => {
      ctx.log(
        `tool> grep ${JSON.stringify({ pattern, path: searchPath, fileGlob, contextLines, caseSensitive })}`,
      );

      const args: string[] = ["--line-number"]; // include file:line
      if (!caseSensitive) args.push("-i");
      if (typeof contextLines === "number") args.push("-C", String(contextLines));
      if (fileGlob) args.push("--glob", fileGlob);

      const validatedSearchPath = await assertReadPathAllowed(
        resolveMaybeRelative(
          searchPath || ctx.config.workingDirectory,
          ctx.config.workingDirectory,
        ),
        ctx.config,
        "grep",
      );

      args.push("--", pattern);
      args.push(validatedSearchPath);

      let rgPath: string;
      try {
        const homedir = resolveCoworkHomedir(ctx.config.userAgentDir);
        rgPath = await ensureRipgrepImpl({ homedir, log: ctx.log });
      } catch (err) {
        const msg = `ripgrep (rg) not available: ${String(err)}`;
        ctx.log(`tool< grep ${JSON.stringify({ error: msg })}`);
        return msg;
      }

      const output = await new Promise<string>((resolve) => {
        execFileImpl(rgPath, args, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
          // ripgrep returns exit code 1 when there are no matches.
          const parsedErrorCode = errorCodeSchema.safeParse(err);
          const code = parsedErrorCode.success ? parsedErrorCode.data.code : undefined;
          if (code === 1) return resolve("No matches found.");
          if (code === "ENOENT") {
            return resolve("ripgrep (rg) not found.");
          }
          if (err) {
            return resolve(`rg failed: ${String(err)}`);
          }
          return resolve(stdout.toString());
        });
      });

      const res = output;
      ctx.log(`tool< grep ${JSON.stringify({ chars: res.length })}`);
      return res;
    },
  });
}
