import { tool } from "ai";
import { z } from "zod";
import { exec } from "node:child_process";

import type { ToolContext } from "./context";
import { truncateText } from "../utils/paths";

export function createBashTool(ctx: ToolContext) {
  return tool({
    description: `Execute a bash command with optional timeout. Use for git, npm, docker, system operations, and anything requiring the shell.

IMPORTANT: Prefer dedicated tools over bash equivalents:
- Reading files: use read (not cat/head/tail)
- Writing files: use write (not echo > / tee)
- Editing files: use edit (not sed/awk)
- Finding files: use glob (not find/ls)
- Searching content: use grep (not grep/rg)

Rules:
- Always quote file paths containing spaces with double quotes
- Prefer absolute paths; avoid cd
- Output is truncated
- Default timeout: 120s; max: 600s`,
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(600000)
        .optional()
        .default(120000)
        .describe("Timeout in ms"),
    }),
    execute: async ({ command, timeout }) => {
      ctx.log(`tool> bash ${JSON.stringify({ command, timeout })}`);

      const approved = await ctx.approveCommand(command);
      if (!approved) {
        const res = { stdout: "", stderr: "User rejected this command.", exitCode: 1 };
        ctx.log(`tool< bash ${JSON.stringify(res)}`);
        return res;
      }

      return await new Promise((resolve) => {
        exec(
          command,
          {
            cwd: ctx.config.workingDirectory,
            timeout,
            maxBuffer: 1024 * 1024 * 10,
          },
          (err, stdout, stderr) => {
            const exitCode = typeof (err as any)?.code === "number" ? (err as any).code : 0;
            const res = {
              stdout: truncateText(String(stdout ?? ""), 30000),
              stderr: truncateText(String(stderr ?? ""), 10000),
              exitCode,
            };
            ctx.log(`tool< bash ${JSON.stringify(res)}`);
            resolve(res);
          }
        );
      });
    },
  });
}
