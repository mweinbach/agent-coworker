import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";

import { getShellCommandPolicyViolation } from "../server/agents/commandPolicy";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const DEFAULT_TIMEOUT_SECONDS = 300; // 5 minutes
const MAX_TIMEOUT_SECONDS = 600; // 10 minutes

// Patterns that may indicate secrets in command output
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|token|password|secret|auth[_-]?token)["']?\s*[:=]\s*["']?[\w\-./+=]{8,}/gi,
  /(?:bearer|basic)\s+[\w\-./+=]{10,}/gi,
  /(?:sk-[a-zA-Z0-9]{20,})/g,
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const prefix = match.slice(0, Math.min(4, match.length));
      return `${prefix}***REDACTED***`;
    });
  }
  return result;
}

type ExecResult = { stdout: string; stderr: string; exitCode: number; errorCode?: string };
type ExecRunner = (
  file: string,
  args: string[],
  opts: {
    cwd: string;
    maxBuffer: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  },
) => Promise<ExecResult>;

const abortByNameSchema = z.object({ name: z.literal("AbortError") }).passthrough();
const errorCodeSchema = z.object({ code: z.union([z.string(), z.number()]) }).passthrough();

function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powerShellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function dedupePathDirs(pathDirs: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of pathDirs) {
    if (!dir) continue;
    const key = platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

function execFileAsync(
  file: string,
  args: string[],
  opts: {
    cwd: string;
    maxBuffer: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
  },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer,
        windowsHide: true,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGTERM" } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        const isAbortByName = abortByNameSchema.safeParse(err).success;
        const parsedErrorCode = errorCodeSchema.safeParse(err);
        const code = parsedErrorCode.success ? parsedErrorCode.data.code : undefined;

        // Detect timeout: Node sets killed=true and signal='SIGTERM' on timeout
        if (
          err &&
          "killed" in err &&
          err.killed === true &&
          "signal" in err &&
          err.signal === "SIGTERM" &&
          opts.timeoutMs
        ) {
          timedOut = true;
        }

        if (timedOut) {
          const timeoutSeconds = (opts.timeoutMs ?? 0) / 1000;
          resolve({
            stdout: String(stdout ?? ""),
            stderr: `Command timed out after ${timeoutSeconds}s. The child process was terminated.`,
            exitCode: 124,
            errorCode: "TIMEOUT",
          });
          return;
        }

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
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          exitCode,
          errorCode,
        });
      },
    );
  });
}

async function runShellCommand(opts: {
  command: string;
  cwd: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<ExecResult> {
  return await runShellCommandWithExec({
    ...opts,
    platform: process.platform,
    execRunner: execFileAsync,
  });
}

let runShellCommandOverrideForTests:
  | ((opts: {
      command: string;
      cwd: string;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
    }) => Promise<ExecResult>)
  | null = null;

function buildShellExecutionPlan(
  platform: NodeJS.Platform,
  command: string,
): Array<{ file: string; args: string[] }> {
  if (platform === "win32") {
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ];
    return [
      { file: "pwsh", args },
      { file: "powershell.exe", args },
    ];
  }

  const userShell = process.env.SHELL?.trim();
  const plan: Array<{ file: string; args: string[] }> = [];

  if (userShell) {
    plan.push({ file: userShell, args: ["-lc", command] });
  }

  plan.push(
    { file: "/bin/bash", args: ["-lc", command] },
    { file: "/bin/sh", args: ["-lc", command] },
    { file: "bash", args: ["-lc", command] },
    { file: "sh", args: ["-lc", command] },
  );

  return plan;
}

async function runShellCommandWithExec(opts: {
  command: string;
  cwd: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  execRunner: ExecRunner;
}): Promise<ExecResult> {
  const maxBuffer = 1024 * 1024 * 10;

  let command = opts.command;
  const env = opts.env || process.env;
  const runtimePython = env.COWORK_CODEX_RUNTIME_PYTHON;
  const runtimeNode = env.COWORK_CODEX_RUNTIME_NODE;
  const managedSofficeShim = env.COWORK_SOFFICE || env.COWORK_MANAGED_SOFFICE_SHIM;
  const managedSofficeShimDir =
    env.COWORK_MANAGED_SOFFICE_SHIM_DIR ||
    (managedSofficeShim ? path.dirname(managedSofficeShim) : undefined);

  const pathDirs: string[] = [];
  if (managedSofficeShimDir) {
    pathDirs.push(managedSofficeShimDir);
  }
  if (runtimeNode) {
    pathDirs.push(path.dirname(runtimeNode));
  }
  if (runtimePython) {
    const pythonDir = path.dirname(runtimePython);
    pathDirs.push(pythonDir);
    if (opts.platform === "win32") {
      pathDirs.push(path.join(pythonDir, "Scripts"));
    }
  }

  const uniquePathDirs = dedupePathDirs(pathDirs, opts.platform);
  const envExports: Record<string, string> = {};
  if (managedSofficeShim) {
    envExports.COWORK_SOFFICE = managedSofficeShim;
  }
  if (managedSofficeShimDir) {
    envExports.COWORK_MANAGED_SOFFICE_SHIM_DIR = managedSofficeShimDir;
  }

  if (uniquePathDirs.length > 0 || Object.keys(envExports).length > 0) {
    if (opts.platform === "win32") {
      const statements: string[] = [];
      if (uniquePathDirs.length > 0) {
        statements.push(
          `$env:PATH = ${powerShellSingleQuote(uniquePathDirs.join(";"))} + ';' + $env:PATH`,
        );
      }
      for (const [key, value] of Object.entries(envExports)) {
        statements.push(`$env:${key} = ${powerShellSingleQuote(value)}`);
      }
      command = `${statements.join("; ")}; ${command}`;
    } else {
      const statements: string[] = [];
      if (uniquePathDirs.length > 0) {
        statements.push(`export PATH=${posixShellQuote(uniquePathDirs.join(":"))}:$PATH`);
      }
      for (const [key, value] of Object.entries(envExports)) {
        statements.push(`export ${key}=${posixShellQuote(value)}`);
      }
      command = `${statements.join(" && ")} && ${command}`;
    }
  }

  const plan = buildShellExecutionPlan(opts.platform, command);

  for (const candidate of plan) {
    const result = await opts.execRunner(candidate.file, candidate.args, {
      cwd: opts.cwd,
      maxBuffer,
      signal: opts.abortSignal,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
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
- Large text output may be saved to the workspace scratchpad when overflow protection is enabled

Timeout: commands default to a ${DEFAULT_TIMEOUT_SECONDS}s timeout and are killed if they exceed it. You may request up to ${MAX_TIMEOUT_SECONDS}s for explicitly long-running operations.`;
}

export function createBashTool(ctx: ToolContext) {
  return defineTool({
    description: buildBashToolDescription(),
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_TIMEOUT_SECONDS)
        .optional()
        .describe(
          `Maximum time to allow the command to run in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}s; max ${MAX_TIMEOUT_SECONDS}s.`,
        ),
    }),
    execute: async ({ command, timeoutSeconds }: { command: string; timeoutSeconds?: number }) => {
      const resolvedTimeoutSeconds = Math.min(
        timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        MAX_TIMEOUT_SECONDS,
      );
      const timeoutMs = resolvedTimeoutSeconds * 1000;
      ctx.log(`tool> bash ${JSON.stringify({ command, timeoutSeconds: resolvedTimeoutSeconds })}`);

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
            `Command blocked by shell policy "${shellPolicyViolation.shellPolicy}": ` +
            `${shellPolicyViolation.reason}. Use read/test/build commands or a write-capable role instead.`,
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

      return await new Promise((resolve, reject) => {
        void (runShellCommandOverrideForTests ?? runShellCommand)({
          command,
          cwd: ctx.config.workingDirectory,
          abortSignal: ctx.abortSignal,
          timeoutMs,
          env: ctx.toolEnv,
        })
          .then(({ stdout, stderr, exitCode }) => {
            const res = {
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              exitCode,
            };
            const redactedRes = {
              stdout: redactSecrets(res.stdout),
              stderr: redactSecrets(res.stderr),
              exitCode: res.exitCode,
            };
            ctx.log(`tool< bash ${JSON.stringify(redactedRes)}`);
            resolve(res);
          })
          .catch(reject);
      });
    },
  });
}

export const __internal = {
  buildBashToolDescription,
  buildShellExecutionPlan,
  runShellCommandWithExec,
  setRunShellCommandForTests(
    runner: (opts: {
      command: string;
      cwd: string;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
      env?: Record<string, string | undefined>;
    }) => Promise<ExecResult>,
  ) {
    runShellCommandOverrideForTests = runner;
  },
  resetRunShellCommandForTests() {
    runShellCommandOverrideForTests = null;
  },
};
