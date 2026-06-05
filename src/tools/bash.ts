import { execFile } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  DEFAULT_SANDBOX_CONFIG,
  isLikelySandboxDenied,
  resolveSandboxPolicy,
  type SandboxCapabilities,
  type SandboxPolicy,
  type SandboxType,
  sandboxManager,
} from "../platform/sandbox";
import {
  buildPlatformShellCommandWithRuntimePrelude,
  buildPlatformShellExecutionPlan,
} from "../platform/shell";
import { getAgentRoleDefinition } from "../server/agents/roles";
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
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGTERM" } : {}), // Node.js converts SIGTERM to Windows process termination
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

/** Exec result augmented with which sandbox backend (if any) wrapped the run. */
type ShellRunResult = ExecResult & { sandbox?: SandboxType; sandboxWarning?: string };

type RunShellCommandOpts = {
  command: string;
  cwd: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Sandbox policy to enforce. Omit or use danger-full-access to run unsandboxed. */
  policy?: SandboxPolicy;
  /** When true, fail closed instead of running unsandboxed if no backend is available. */
  requireBackend?: boolean;
  /**
   * Called before falling back to an UNSANDBOXED run because no OS sandbox backend
   * is available (restrictive policy + `requireBackend: false`). Running with full
   * filesystem access is a privilege increase, so the caller may prompt; return
   * false to refuse. Not consulted for `danger-full-access` (intentional full
   * access) or when a backend is available.
   */
  approveUnsandboxed?: () => Promise<boolean>;
  /** Injectable sandbox capabilities (for tests). */
  capabilities?: SandboxCapabilities;
  /** Injectable existence check for shell selection (for tests). */
  exists?: (p: string) => boolean;
};

async function runShellCommand(opts: RunShellCommandOpts): Promise<ShellRunResult> {
  return await runShellCommandWithExec({
    ...opts,
    platform: process.platform,
    execRunner: execFileAsync,
  });
}

let runShellCommandOverrideForTests:
  | ((opts: RunShellCommandOpts) => Promise<ShellRunResult>)
  | null = null;

/** Read the search-path env var case-insensitively (Windows uses `Path`, not `PATH`). */
function readPathVar(env: Record<string, string | undefined> | undefined): string {
  const source = env ?? process.env;
  for (const key of Object.keys(source)) {
    if (key.toUpperCase() === "PATH") {
      const value = source[key];
      if (value) return value;
    }
  }
  return process.env.PATH ?? "";
}

/**
 * Resolve the first shell candidate to a concrete program path. Absolute
 * candidates are checked with `exists`; bare names (e.g. `pwsh`,
 * `powershell.exe`) are searched on PATH (also trying common executable
 * extensions on Windows). Returns the candidate with its `file` rewritten to the
 * resolved path, or `null` when none resolve.
 */
function resolveInnerCandidate(
  plan: { file: string; args: string[] }[],
  exists: (p: string) => boolean,
  env: Record<string, string | undefined> | undefined,
  platform: NodeJS.Platform,
): { file: string; args: string[] } | null {
  const pathDirs = readPathVar(env).split(path.delimiter).filter(Boolean);
  const exts = platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".com"] : [""];
  for (const candidate of plan) {
    if (path.isAbsolute(candidate.file)) {
      if (exists(candidate.file)) return candidate;
      continue;
    }
    for (const dir of pathDirs) {
      for (const ext of exts) {
        const resolved = path.join(dir, candidate.file + ext);
        if (exists(resolved)) return { file: resolved, args: candidate.args };
      }
    }
  }
  return null;
}

async function runShellCommandWithExec(
  opts: RunShellCommandOpts & { platform: NodeJS.Platform; execRunner: ExecRunner },
): Promise<ShellRunResult> {
  const maxBuffer = 1024 * 1024 * 10;
  const exists = opts.exists ?? ((p: string) => fsSync.existsSync(p));

  const command = buildPlatformShellCommandWithRuntimePrelude({
    command: opts.command,
    platform: opts.platform,
    env: opts.env,
  });
  const plan = buildPlatformShellExecutionPlan(opts.platform, command);
  const policy = opts.policy;

  // Determine whether an OS sandbox applies (independent of which shell we pick).
  const probe =
    policy && plan.length > 0
      ? sandboxManager.transform({
          file: plan[0].file,
          args: [],
          policy,
          cwd: opts.cwd,
          platform: opts.platform,
          capabilities: opts.capabilities,
        })
      : null;

  // Fail closed when configured to require a backend that is unavailable.
  if (
    policy &&
    policy.kind !== "danger-full-access" &&
    opts.requireBackend &&
    probe &&
    probe.sandbox === "none"
  ) {
    return {
      stdout: "",
      stderr: `Refusing to run unsandboxed: ${probe.warning ?? "OS sandbox backend unavailable"} (sandbox.requireBackend is enabled).`,
      exitCode: 1,
      errorCode: "SANDBOX_REQUIRED",
      sandbox: "none",
      sandboxWarning: probe.warning,
    };
  }

  if (policy && probe && probe.sandbox !== "none") {
    // Resolve the inner shell to a concrete program BEFORE wrapping. Once wrapped
    // the sandbox binary is argv[0], so the ENOENT-based shell fallback used in
    // the unsandboxed loop can no longer see a missing inner shell. Pick the
    // first candidate that resolves (absolute path that exists, or a bare name
    // found on PATH — e.g. powershell.exe when pwsh is absent), else the first.
    const inner = resolveInnerCandidate(plan, exists, opts.env, opts.platform) ?? plan[0];
    const wrapped = sandboxManager.transform({
      file: inner.file,
      args: inner.args,
      policy,
      cwd: opts.cwd,
      platform: opts.platform,
      capabilities: opts.capabilities,
    });
    const result = await opts.execRunner(wrapped.file, wrapped.args, {
      cwd: opts.cwd,
      maxBuffer,
      signal: opts.abortSignal,
      timeoutMs: opts.timeoutMs,
      // Passing an `env` object replaces (not merges) the child environment, so
      // fall back to `process.env` when no toolEnv is set (e.g. a raw delegate
      // context) — otherwise sandboxed commands would lose HOME/PATH/etc. that
      // the unsandboxed path inherits. Sandbox markers overlay last.
      env: { ...(opts.env ?? process.env), ...wrapped.env },
    });
    return { ...result, sandbox: wrapped.sandbox, sandboxWarning: wrapped.warning };
  }

  // Restrictive policy but no backend available (requireBackend=false): falling
  // back to an unsandboxed run grants full filesystem access, so require approval
  // first — mirroring the escalate-on-failure prompt — rather than running and
  // only warning afterwards. danger-full-access is intentional full access and is
  // not gated here; under YOLO the approval auto-returns true.
  if (
    policy &&
    policy.kind !== "danger-full-access" &&
    probe &&
    probe.sandbox === "none" &&
    opts.approveUnsandboxed &&
    !(await opts.approveUnsandboxed())
  ) {
    return {
      stdout: "",
      stderr: `Refusing to run unsandboxed: ${probe.warning ?? "OS sandbox backend unavailable"} (declined).`,
      exitCode: 1,
      errorCode: "SANDBOX_REQUIRED",
      sandbox: "none",
      sandboxWarning: probe.warning,
    };
  }

  // Unsandboxed: try shell candidates until one is not missing (ENOENT).
  for (const candidate of plan) {
    const result = await opts.execRunner(candidate.file, candidate.args, {
      cwd: opts.cwd,
      maxBuffer,
      signal: opts.abortSignal,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
    });
    if (result.errorCode !== "ENOENT") {
      return { ...result, sandbox: "none", sandboxWarning: probe?.warning };
    }
  }

  return {
    stdout: "",
    stderr: `No compatible shell executable was found for platform ${opts.platform}.`,
    exitCode: 1,
    errorCode: "ENOENT",
    sandbox: "none",
    sandboxWarning: probe?.warning,
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
  const description = ctx.agentTargetPaths?.length
    ? `${buildBashToolDescription()}\n\nChild targetPaths scope: the OS sandbox makes only your assigned targetPaths (plus temp) writable — writes elsewhere are denied at the OS level, not by parsing the command. Reads are not path-scoped for bash; prefer read/write/edit/glob/grep when you need strictly scoped file access.`
    : buildBashToolDescription();
  return defineTool({
    description,
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

      // The OS sandbox (src/platform/sandbox) is the enforcement boundary. We
      // run the command inside it and only fall back to prompting the user when
      // a sandboxed command fails in a way that looks like a sandbox denial.
      //
      // If a ToolContext was built without a resolved sandboxPolicy (e.g. an
      // alternate delegate path), derive one here from the role + config rather
      // than defaulting to full access, so read-only roles and targetPaths stay
      // enforced instead of silently running unsandboxed.
      const sandboxConfig = {
        ...DEFAULT_SANDBOX_CONFIG,
        ...(ctx.config.sandbox ?? {}),
      };
      const policy: SandboxPolicy =
        ctx.sandboxPolicy ??
        resolveSandboxPolicy({
          config: sandboxConfig,
          // Honor a read-only role OR an explicit no_project_write shell policy,
          // matching agent.ts so this fallback can't resolve looser than the
          // precomputed policy would.
          readOnlyRole:
            (ctx.agentRole ? getAgentRoleDefinition(ctx.agentRole).readOnly : false) ||
            ctx.shellPolicy === "no_project_write",
          workingDirectory: ctx.config.workingDirectory,
          projectRoot: path.dirname(ctx.config.projectCoworkDir),
          outputDirectory: ctx.config.outputDirectory,
          uploadsDirectory: ctx.config.uploadsDirectory,
          targetPaths: ctx.agentTargetPaths,
        });
      const runner = runShellCommandOverrideForTests ?? runShellCommand;
      // Read-only roles and scoped children (targetPaths) are hard floors: their
      // read-only / scope guarantee must never be relaxed to an unsandboxed
      // full-access run, so fail closed when no backend is available regardless
      // of the configured requireBackend. Only an unscoped workspace-write
      // session may take the approved unsandboxed fallback.
      const isHardFloor = policy.kind === "read-only" || (ctx.agentTargetPaths?.length ?? 0) > 0;
      const baseArgs = {
        command,
        cwd: ctx.config.workingDirectory,
        abortSignal: ctx.abortSignal,
        timeoutMs,
        env: ctx.toolEnv,
        requireBackend: sandboxConfig.requireBackend || isHardFloor,
        // Prompt before running unsandboxed when no backend is available. Uses a
        // non-"sandbox_denied" reason so YOLO auto-approves (the user opted into
        // requireBackend=false) while a non-YOLO session still confirms.
        approveUnsandboxed: () => ctx.approveCommand(command, { reason: "sandbox_unavailable" }),
      };

      let result = await runner({ ...baseArgs, policy });
      if (result.sandboxWarning) {
        ctx.log(`tool> bash sandbox unavailable: ${result.sandboxWarning}`);
      }

      // Escalate-on-failure: when a sandboxed command fails in a way that looks
      // like a sandbox denial, ask the user whether to re-run it unsandboxed.
      // Never escalate (a) read-only policies — that would violate the read-only
      // floor, or (b) a scoped child (with targetPaths) — escalating to full
      // access would bypass the child's scope entirely (especially under YOLO,
      // where approval auto-returns true). Only an unscoped workspace-write
      // session may be lifted to danger-full-access.
      const wasSandboxed = result.sandbox !== undefined && result.sandbox !== "none";
      const isScopedChild = (ctx.agentTargetPaths?.length ?? 0) > 0;
      const networkRestricted = policy.kind !== "danger-full-access" && !policy.network;
      if (
        policy.kind === "workspace-write" &&
        !isScopedChild &&
        wasSandboxed &&
        result.exitCode !== 0 &&
        isLikelySandboxDenied(result, { networkRestricted })
      ) {
        const approved = await ctx.approveCommand(command, { reason: "sandbox_denied" });
        if (approved) {
          result = await runner({ ...baseArgs, policy: { kind: "danger-full-access" } });
        }
      }

      // Surface the sandbox warning in the command output (not just logs) so the
      // model/user can see enforcement was degraded. Excluded for the fail-closed
      // case, which already explains itself. When a partial backend ran the
      // command (e.g. the Windows restricted-token helper), don't claim it ran
      // "without an OS sandbox" — show the warning verbatim instead.
      const surfaceWarning =
        result.sandboxWarning !== undefined && result.errorCode !== "SANDBOX_REQUIRED";
      const sandboxNotice = !surfaceWarning
        ? ""
        : result.sandbox === undefined || result.sandbox === "none"
          ? `[sandbox] ${result.sandboxWarning}; command ran without an OS sandbox.\n`
          : `[sandbox] ${result.sandboxWarning}\n`;
      const res = {
        stdout: String(result.stdout ?? ""),
        stderr: sandboxNotice + String(result.stderr ?? ""),
        exitCode: result.exitCode,
      };
      const redactedRes = {
        stdout: redactSecrets(res.stdout),
        stderr: redactSecrets(res.stderr),
        exitCode: res.exitCode,
      };
      ctx.log(`tool< bash ${JSON.stringify(redactedRes)}`);
      return res;
    },
  });
}

export const __internal = {
  buildBashToolDescription,
  buildShellExecutionPlan: buildPlatformShellExecutionPlan,
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
