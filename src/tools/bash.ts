import { z } from "zod";
import { execFile } from "node:child_process";

import { getShellCommandPolicyViolation } from "../server/agents/commandPolicy";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

type ExecResult = { stdout: string; stderr: string; exitCode: number; errorCode?: string };
type ExecRunner = (
  file: string,
  args: string[],
  opts: { cwd: string; maxBuffer: number; signal?: AbortSignal }
) => Promise<ExecResult>;

const abortByNameSchema = z.object({ name: z.literal("AbortError") }).passthrough();
const errorCodeSchema = z.object({ code: z.union([z.string(), z.number()]) }).passthrough();

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
        const isAbortByName = abortByNameSchema.safeParse(err).success;
        const parsedErrorCode = errorCodeSchema.safeParse(err);
        const code = parsedErrorCode.success ? parsedErrorCode.data.code : undefined;
        if (isAbortByName || code === "ABORT_ERR") {
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "") || "Command aborted.",
            exitCode: 130,
            errorCode: "ABORT_ERR",
          });
          return;
        }
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
  return await runShellCommandWithExec({
    ...opts,
    platform: process.platform,
    execRunner: execFileAsync,
  });
}

let runShellCommandOverrideForTests:
  | ((opts: { command: string; cwd: string; abortSignal?: AbortSignal }) => Promise<ExecResult>)
  | null = null;

function buildShellExecutionPlan(platform: NodeJS.Platform, command: string): Array<{ file: string; args: string[] }> {
  if (platform === "win32") {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command];
    return [
      { file: "pwsh", args },
      { file: "powershell.exe", args },
    ];
  }

  return [
    { file: "/bin/bash", args: ["-lc", command] },
    { file: "/bin/sh", args: ["-lc", command] },
    { file: "bash", args: ["-lc", command] },
    { file: "sh", args: ["-lc", command] },
  ];
}

async function runShellCommandWithExec(opts: {
  command: string;
  cwd: string;
  abortSignal?: AbortSignal;
  platform: NodeJS.Platform;
  execRunner: ExecRunner;
}): Promise<ExecResult> {
  const maxBuffer = 1024 * 1024 * 10;
  const plan = buildShellExecutionPlan(opts.platform, opts.command);

  for (const candidate of plan) {
    const result = await opts.execRunner(candidate.file, candidate.args, {
      cwd: opts.cwd,
      maxBuffer,
      signal: opts.abortSignal,
    });
    if (result.errorCode !== "ENOENT") return result;
  }

  return {
    stdout: "",
    stderr: `No compatible shell executable was found for platform ${opts.platform}.`,
    exitCode: 1,
    errorCode: "ENOENT",
  };
}

function buildBashToolDescription(): string {
  return `Execute a shell command. Use for git, npm, docker, system operations, and anything requiring the shell.

Platform notes:
- Windows: runs in PowerShell, preferring \`pwsh\` and falling back to \`powershell.exe\`
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
- On Windows, do not rely on \`&&\`, \`export\`, or \`source\`; use PowerShell syntax such as \`;\`, \`$env:NAME = "value"\`, and separate tool calls when that is clearer
- On Windows, prefer \`py -3\` or \`python\` for Python commands
- Large text output may be saved to the workspace scratchpad when overflow protection is enabled`;
}

export function createBashTool(ctx: ToolContext) {
  return defineTool({
    description: buildBashToolDescription(),
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
    }),
    execute: async ({ command }: { command: string }) => {
      ctx.log(`tool> bash ${JSON.stringify({ command })}`);

      if (ctx.abortSignal?.aborted) {
        const res = { stdout: "", stderr: "Command aborted.", exitCode: 130 };
        ctx.log(`tool< bash ${JSON.stringify(res)}`);
        return res;
      }

      const shellPolicyViolation = getShellCommandPolicyViolation(command, ctx.shellPolicy);
      if (shellPolicyViolation) {
        const res = {
          stdout: "",
          stderr:
            `Command blocked by shell policy "${shellPolicyViolation.shellPolicy}": `
            + `${shellPolicyViolation.reason}. Use read/test/build commands or a write-capable role instead.`,
          exitCode: 1,
        };
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
        void (runShellCommandOverrideForTests ?? runShellCommand)({
          command,
          cwd: ctx.config.workingDirectory,
          abortSignal: ctx.abortSignal,
        }).then(({ stdout, stderr, exitCode }) => {
          const res = {
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            exitCode,
          };
          ctx.log(`tool< bash ${JSON.stringify(res)}`);
          resolve(res);
        });
      });
    },
  });
}

export const __internal = {
  buildBashToolDescription,
  buildShellExecutionPlan,
  runShellCommandWithExec,
  setRunShellCommandForTests(
    runner: (opts: { command: string; cwd: string; abortSignal?: AbortSignal }) => Promise<ExecResult>
  ) {
    runShellCommandOverrideForTests = runner;
  },
  resetRunShellCommandForTests() {
    runShellCommandOverrideForTests = null;
  },
};
