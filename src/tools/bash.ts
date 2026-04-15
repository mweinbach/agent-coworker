import { z } from "zod";

import {
  __internal as localExecutionInternal,
  defaultLocalToolExecutionBackend,
} from "../execution/local";
import { getShellCommandPolicyViolation } from "../server/agents/commandPolicy";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

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

      const executionBackend = ctx.executionBackend ?? defaultLocalToolExecutionBackend;
      const { stdout, stderr, exitCode } = await executionBackend.runShellCommand({
        command,
        cwd: ctx.config.workingDirectory,
        abortSignal: ctx.abortSignal,
      });
      const res = {
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        exitCode,
      };
      ctx.log(`tool< bash ${JSON.stringify(res)}`);
      return res;
    },
  });
}

export const __internal = {
  buildBashToolDescription,
  buildShellExecutionPlan: localExecutionInternal.buildShellExecutionPlan,
  runShellCommandWithExec: localExecutionInternal.runShellCommandWithExec,
  setRunShellCommandForTests: localExecutionInternal.setRunShellCommandForTests,
  resetRunShellCommandForTests: localExecutionInternal.resetRunShellCommandForTests,
};
