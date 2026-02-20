import { tool } from "ai";
import { z } from "zod";
import { execFile } from "node:child_process";

import type { ToolContext } from "./context";
import { truncateText } from "../utils/paths";

type ExecResult = { stdout: string; stderr: string; exitCode: number; errorCode?: string };

function execFileAsync(
  file: string,
  args: string[],
  opts: { cwd: string; maxBuffer: number; signal?: AbortSignal }
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer,
        windowsHide: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        if ((err as any)?.name === "AbortError" || (err as any)?.code === "ABORT_ERR") {
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "") || "Command aborted.",
            exitCode: 130,
            errorCode: "ABORT_ERR",
          });
          return;
        }
        const code = (err as any)?.code;
        const errorCode = typeof code === "string" ? code : undefined;
        const exitCode = typeof code === "number" ? code : err ? 1 : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode, errorCode });
      }
    );
  });
}

async function runShellCommand(opts: {
  command: string;
  cwd: string;
  abortSignal?: AbortSignal;
}): Promise<ExecResult> {
  const maxBuffer = 1024 * 1024 * 10;

  if (process.platform === "win32") {
    // Prefer PowerShell on Windows. `powershell.exe` is available by default on supported versions.
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", opts.command];
    const primary = await execFileAsync("powershell.exe", args, {
      cwd: opts.cwd,
      maxBuffer,
      signal: opts.abortSignal,
    });
    if (primary.errorCode !== "ENOENT") return primary;
    return await execFileAsync("pwsh", args, {
      cwd: opts.cwd,
      maxBuffer,
      signal: opts.abortSignal,
    });
  }

  // macOS/Linux: prefer bash; fall back to sh.
  const bash = await execFileAsync("bash", ["-lc", opts.command], {
    cwd: opts.cwd,
    maxBuffer,
    signal: opts.abortSignal,
  });
  if (bash.errorCode !== "ENOENT") return bash;
  return await execFileAsync("sh", ["-lc", opts.command], {
    cwd: opts.cwd,
    maxBuffer,
    signal: opts.abortSignal,
  });
}

export function createBashTool(ctx: ToolContext) {
  return tool({
    description: `Execute a shell command. Use for git, npm, docker, system operations, and anything requiring the shell.

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
- Output is truncated`,
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
    }),
    execute: async ({ command }) => {
      ctx.log(`tool> bash ${JSON.stringify({ command })}`);

      if (ctx.abortSignal?.aborted) {
        const res = { stdout: "", stderr: "Command aborted.", exitCode: 130 };
        ctx.log(`tool< bash ${JSON.stringify(res)}`);
        return res;
      }

      const approved = await ctx.approveCommand(command);
      if (!approved) {
        const res = { stdout: "", stderr: "User rejected this command.", exitCode: 1 };
        ctx.log(`tool< bash ${JSON.stringify(res)}`);
        return res;
      }

      return await new Promise((resolve) => {
        void runShellCommand({
          command,
          cwd: ctx.config.workingDirectory,
          abortSignal: ctx.abortSignal,
        }).then(({ stdout, stderr, exitCode }) => {
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
