import { tool } from "ai";
import { z } from "zod";
import { execFile } from "node:child_process";

import type { ToolContext } from "./context";
import { truncateText } from "../utils/paths";

export function createGrepTool(ctx: ToolContext) {
  return tool({
    description:
      "Search file contents for a regex pattern using ripgrep (rg). Returns matching lines with filenames and line numbers.",
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern"),
      path: z.string().optional().describe("File or directory to search"),
      fileGlob: z.string().optional().describe("Glob to filter files (e.g. *.ts)"),
      contextLines: z.number().int().min(0).max(50).optional().describe("Context lines around matches"),
      caseSensitive: z.boolean().optional().default(true),
    }),
    execute: async ({ pattern, path: searchPath, fileGlob, contextLines, caseSensitive }) => {
      ctx.log(
        `tool> grep ${JSON.stringify({ pattern, path: searchPath, fileGlob, contextLines, caseSensitive })}`
      );

      const args: string[] = ["--line-number"]; // include file:line
      if (!caseSensitive) args.push("-i");
      if (typeof contextLines === "number") args.push("-C", String(contextLines));
      if (fileGlob) args.push("--glob", fileGlob);
      args.push(pattern);
      args.push(searchPath || ctx.config.workingDirectory);

      const output = await new Promise<string>((resolve) => {
        execFile("rg", args, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
          // ripgrep returns exit code 1 when there are no matches.
          const code = (err as any)?.code;
          if (code === 1) return resolve("No matches found.");
          if ((err as any)?.code === "ENOENT") {
            return resolve("ripgrep (rg) not found. Install rg to use grep tool.");
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
