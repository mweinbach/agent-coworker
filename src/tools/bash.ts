import { tool } from "ai";
import { z } from "zod";
import { execFile } from "node:child_process";

import type { ToolContext } from "./context";
import { truncateText } from "../utils/paths";

type ExecResult = { stdout: string; stderr: string; exitCode: number; errorCode?: string };

function execFileAsync(
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; maxBuffer: number }
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = (err as any)?.code;
        const errorCode = typeof code === "string" ? code : undefined;
        const exitCode = typeof code === "number" ? code : err ? 1 : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode, errorCode });
      }
    );
  });
}

async function runShellCommand(opts: { command: string; cwd: string; timeout: number }): Promise<ExecResult> {
  const maxBuffer = 1024 * 1024 * 10;

  if (process.platform === "win32") {
    // Prefer PowerShell on Windows. `powershell.exe` is available by default on supported versions.
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", opts.command];
    const primary = await execFileAsync("powershell.exe", args, { cwd: opts.cwd, timeout: opts.timeout, maxBuffer });
    if (primary.errorCode !== "ENOENT") return primary;
    return await execFileAsync("pwsh", args, { cwd: opts.cwd, timeout: opts.timeout, maxBuffer });
  }

  // macOS/Linux: prefer bash; fall back to sh.
  const bash = await execFileAsync("bash", ["-lc", opts.command], { cwd: opts.cwd, timeout: opts.timeout, maxBuffer });
  if (bash.errorCode !== "ENOENT") return bash;
  return await execFileAsync("sh", ["-lc", opts.command], { cwd: opts.cwd, timeout: opts.timeout, maxBuffer });
}

export function createBashTool(ctx: ToolContext) {
  return tool({
    description: `Execute a shell command with optional timeout. Use for git, npm, docker, system operations, and anything requiring the shell.

Platform notes:
- Windows: runs in PowerShell
- macOS/Linux: runs in bash (or sh fallback)

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
        void runShellCommand({ command, cwd: ctx.config.workingDirectory, timeout }).then(({ stdout, stderr, exitCode }) => {
          const res = {
            stdout: truncateText(String(stdout ?? ""), 30000),
            stderr: truncateText(String(stderr ?? ""), 10000),
            exitCode,
          };
          ctx.log(`tool< bash ${JSON.stringify(res)}`);
          resolve(res);
        });
      });
    },
  });
}
