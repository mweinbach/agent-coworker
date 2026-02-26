import { Type } from "../pi/types";
import { z } from "zod";
import { execFile } from "node:child_process";
import path from "node:path";

import { toAgentTool } from "../pi/toolAdapter";
import type { ToolContext } from "./context";
import { resolveMaybeRelative, truncateText } from "../utils/paths";
import { ensureRipgrep } from "../utils/ripgrep";
import { assertReadPathAllowed } from "../utils/permissions";

const errorCodeSchema = z.object({ code: z.union([z.string(), z.number()]) }).passthrough();

export function createGrepTool(
  ctx: ToolContext,
  opts: { execFileImpl?: typeof execFile; ensureRipgrepImpl?: typeof ensureRipgrep } = {}
) {
  const execFileImpl = opts.execFileImpl ?? execFile;
  const ensureRipgrepImpl = opts.ensureRipgrepImpl ?? ensureRipgrep;

  return toAgentTool({
    name: "grep",
    description:
      "Search file contents for a regex pattern using ripgrep (rg). Returns matching lines with filenames and line numbers. If rg is missing, Cowork will auto-download it.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regex pattern" }),
      path: Type.Optional(Type.String({ description: "File or directory to search" })),
      fileGlob: Type.Optional(Type.String({ description: "Glob to filter files (e.g. *.ts)" })),
      contextLines: Type.Optional(Type.Integer({ description: "Context lines around matches", minimum: 0, maximum: 50 })),
      caseSensitive: Type.Optional(Type.Boolean({ description: "Case sensitive search", default: true })),
    }),
    execute: async ({ pattern, path: searchPath, fileGlob, contextLines, caseSensitive: rawCaseSensitive }) => {
      const caseSensitive = rawCaseSensitive ?? true;
      ctx.log(
        `tool> grep ${JSON.stringify({ pattern, path: searchPath, fileGlob, contextLines, caseSensitive })}`
      );

      const args: string[] = ["--line-number"]; // include file:line
      if (!caseSensitive) args.push("-i");
      if (typeof contextLines === "number") args.push("-C", String(contextLines));
      if (fileGlob) args.push("--glob", fileGlob);

      const validatedSearchPath = await assertReadPathAllowed(
        resolveMaybeRelative(searchPath || ctx.config.workingDirectory, ctx.config.workingDirectory),
        ctx.config,
        "grep"
      );

      args.push("--", pattern);
      args.push(validatedSearchPath);

      let rgPath: string;
      try {
        const homedir = path.dirname(ctx.config.userAgentDir);
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

      const res = truncateText(output, 30000);
      ctx.log(`tool< grep ${JSON.stringify({ chars: res.length })}`);
      return res;
    },
  });
}
