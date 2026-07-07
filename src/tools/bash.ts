import fsSync from "node:fs";
import path from "node:path";
import { z } from "zod";
import { minimalSandboxEnv } from "../platform/env";
import { which } from "../platform/exec";
import { hostPlatform } from "../platform/host";
import {
  classifySandboxDenial,
  DEFAULT_SANDBOX_CONFIG,
  describeSandboxDenial,
  isLikelySandboxDenied,
  policyAllowsNetwork,
  resolveSandboxPolicy,
  type SandboxCapabilities,
  type SandboxPolicy,
  type SandboxType,
  sandboxManager,
} from "../platform/sandbox";
import {
  buildPlatformShellCommandWithRuntimePrelude,
  buildPlatformShellExecutionPlan,
  promptGuidance as shellPromptGuidance,
} from "../platform/shell";
import { getAgentRoleDefinition } from "../server/agents/roles";
import { classifyCommandDetailed } from "../utils/approval";
import { execFileCompat } from "../utils/execFileCompat";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const DEFAULT_TIMEOUT_SECONDS = 300; // 5 minutes
const MAX_TIMEOUT_SECONDS = 600; // 10 minutes

// Patterns that may indicate secrets in command output (redacted in logs only).
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|token|password|secret|auth[_-]?token)["']?\s*[:=]\s*["']?[\w\-./+=]{8,}/gi,
  /(?:bearer|basic)\s+[\w\-./+=]{10,}/gi,
  /(?:sk-[a-zA-Z0-9]{20,})/g,
  // Common UPPER_CASE env-var assignments (e.g. ANTHROPIC_API_KEY=..., OPENAI_API_KEY=...)
  // that the generic api_key pattern above misses (no value separator after the var name).
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["']?[\w\-./+=]{8,}/g,
  // Provider/CI token formats with recognizable prefixes.
  /\bgh[posru]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /X-Amz-Security-Token[:=]\s*[\w+/]{40,}/gi,
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

async function execFileAsync(
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
  const result = await execFileCompat(file, args, {
    cwd: opts.cwd,
    maxBuffer: opts.maxBuffer,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (result.errorCode === "TIMEOUT") {
    const timeoutSeconds = (opts.timeoutMs ?? 0) / 1000;
    return {
      stdout: result.stdout,
      stderr: `Command timed out after ${timeoutSeconds}s. The child process was terminated.`,
      exitCode: 124,
      errorCode: "TIMEOUT",
    };
  }
  if (result.errorCode === "ABORT_ERR") {
    return {
      stdout: result.stdout,
      stderr: result.stderr || "Command aborted.",
      exitCode: 130,
      errorCode: "ABORT_ERR",
    };
  }
  return result;
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
   * When true, the policy MUST be enforced by the backend (filesystem/scope), not
   * merely process-contained. Used for hard-floor contexts (read-only roles,
   * scoped children): a non-enforcing backend (e.g. the Windows restricted-token
   * helper) or no backend fails closed, with no unsandboxed fallback.
   */
  requireEnforcingBackend?: boolean;
  /**
   * Called before falling back to an UNSANDBOXED run because no OS sandbox backend
   * is available (restrictive policy + `requireBackend: false`). Running with full
   * filesystem access is a privilege increase, so the caller may prompt; return
   * false to refuse. Not consulted for `danger-full-access` (intentional full
   * access) or when a backend is available.
   */
  approveUnsandboxed?: () => Promise<boolean>;
  /** Rechecked after an unsandboxed fallback approval and before execution. */
  assertCanMutate?: () => Promise<void>;
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

async function runShellCommandWithExec(
  opts: RunShellCommandOpts & { platform: NodeJS.Platform; execRunner: ExecRunner },
): Promise<ShellRunResult> {
  const maxBuffer = 1024 * 1024 * 10;

  const command = buildPlatformShellCommandWithRuntimePrelude({
    command: opts.command,
    platform: opts.platform,
    env: opts.env,
  });
  const plan = buildPlatformShellExecutionPlan(opts.platform, command);
  const policy = opts.policy;

  // Resolve every shell candidate through THE resolver (platform/exec.which)
  // so the sandboxed and unsandboxed lanes bind the SAME binary — they used
  // two different mechanisms (hand-rolled PATH walk vs spawn-layer lookup)
  // and could bind different shells on one machine. Unresolved candidates
  // keep their bare name: the spawn layer's ENOENT then advances the
  // fallback chain exactly as before.
  const resolvedPlan = plan.map((step) => {
    const file = which(step.file, {
      env: opts.env,
      platform: opts.platform,
      ...(opts.exists ? { exists: opts.exists } : {}),
    });
    return file ? { ...step, file, resolved: true } : { ...step, resolved: false };
  });

  // Oversized win32 commands ship as a -File temp script (see
  // buildPlatformShellExecutionPlan). All steps of a plan share one script:
  // materialize it before any spawn, remove it when the run settles.
  const tempScript = plan.find((step) => step.tempScript)?.tempScript;
  if (tempScript) {
    fsSync.writeFileSync(tempScript.path, tempScript.content);
  }
  try {
    const inner =
      policy && resolvedPlan.length > 0
        ? (resolvedPlan.find((step) => step.resolved) ?? resolvedPlan[0])
        : null;
    const transformed =
      policy && inner
        ? sandboxManager.transform({
            file: inner.file,
            args: inner.args,
            policy,
            cwd: opts.cwd,
            platform: opts.platform,
            capabilities: opts.capabilities,
          })
        : null;

    const requiresSandboxEnforcement =
      policy !== undefined &&
      (policy.kind !== "danger-full-access" || !policyAllowsNetwork(policy));
    const backendDoesNotEnforcePolicy =
      !transformed ||
      transformed.sandbox === "none" ||
      !transformed.enforcement.integrity ||
      !transformed.enforcement.process ||
      (policy?.kind !== "danger-full-access" && !transformed.enforcement.filesystem) ||
      (policy !== undefined && !policyAllowsNetwork(policy) && !transformed.enforcement.network);

    // Hard-floor contexts (read-only roles, scoped children) require every policy
    // dimension to be enforced. A degraded or missing backend must fail closed —
    // never run such a context unenforced, and never offer a fallback.
    if (
      policy &&
      requiresSandboxEnforcement &&
      opts.requireEnforcingBackend &&
      backendDoesNotEnforcePolicy
    ) {
      return {
        stdout: "",
        stderr: `Refusing to run: this context requires an enforcing OS sandbox, which is unavailable (${transformed?.warning ?? "no backend"}).`,
        exitCode: 1,
        errorCode: "SANDBOX_REQUIRED",
        sandbox: "none",
        sandboxWarning: transformed?.warning,
      };
    }

    // Fail closed when configured to require an enforcing backend. A backend whose
    // native probe cannot prove the requested dimensions is not enough to satisfy
    // the default safety contract.
    if (
      policy &&
      requiresSandboxEnforcement &&
      opts.requireBackend &&
      backendDoesNotEnforcePolicy
    ) {
      const reason = transformed?.warning ?? "OS sandbox backend unavailable";
      const stderr =
        transformed && transformed.sandbox !== "none"
          ? `Refusing to run: ${reason} (sandbox.requireBackend is enabled and requires filesystem/network enforcement).`
          : `Refusing to run unsandboxed: ${reason} (sandbox.requireBackend is enabled).`;
      return {
        stdout: "",
        stderr,
        exitCode: 1,
        errorCode: "SANDBOX_REQUIRED",
        sandbox: "none",
        sandboxWarning: transformed?.warning,
      };
    }

    // A restrictive policy whose backend does NOT enforce filesystem/network scope
    // is effectively unsandboxed for FS/network. This includes no backend at all
    // (`sandbox === "none"`) and any backend that fails its native capability or
    // integrity probe. Running it grants full filesystem/network access despite
    // workspace-write / no-network expectations, so require explicit unsandboxed
    // approval BEFORE executing — mirroring the escalate-on-failure prompt —
    // rather than silently running under it and only warning afterwards. The
    // requireEnforcingBackend / requireBackend gates above already fail closed for
    // stricter contexts; danger-full-access with network allowed is not restrictive
    // and never reaches here.
    if (
      policy &&
      requiresSandboxEnforcement &&
      backendDoesNotEnforcePolicy &&
      opts.approveUnsandboxed
    ) {
      if (!(await opts.approveUnsandboxed())) {
        return {
          stdout: "",
          stderr: `Refusing to run: ${transformed?.warning ?? "OS sandbox backend does not enforce filesystem/network scope"} (declined).`,
          exitCode: 1,
          errorCode: "SANDBOX_REQUIRED",
          sandbox: "none",
          sandboxWarning: transformed?.warning,
        };
      }
      await opts.assertCanMutate?.();
    }

    // A backend is present and either enforcing or the unsandboxed fallback was
    // approved above. Run the possibly wrapped command.
    if (policy && transformed && transformed.sandbox !== "none") {
      const result = await opts.execRunner(transformed.file, transformed.args, {
        cwd: opts.cwd,
        maxBuffer,
        signal: opts.abortSignal,
        timeoutMs: opts.timeoutMs,
        // Passing an `env` object replaces (not merges) the child environment.
        // The OS sandbox confines filesystem writes, but NOT environment access:
        // a sandboxed command can still read every variable it is handed and (with
        // network allowed, the default) exfiltrate it. So the child must never see
        // the server's full process env — which carries provider API keys and other
        // secrets. Filter to the compatibility allowlist (PATH/HOME/locale plus the
        // Cowork runtime pointers; see SANDBOX_ENV_ALLOWLIST).
        // The versioned runtime PATH directories are injected into the command
        // string by buildPlatformShellCommandWithRuntimePrelude. Sandbox marker vars
        // overlay last.
        env: { ...minimalSandboxEnv(opts.env), ...transformed.env },
      });
      return { ...result, sandbox: transformed.sandbox, sandboxWarning: transformed.warning };
    }

    // Unsandboxed: try shell candidates until one is not missing (ENOENT).
    for (const candidate of resolvedPlan) {
      const result = await opts.execRunner(candidate.file, candidate.args, {
        cwd: opts.cwd,
        maxBuffer,
        signal: opts.abortSignal,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
      });
      if (result.errorCode !== "ENOENT") {
        return { ...result, sandbox: "none", sandboxWarning: transformed?.warning };
      }
    }

    return {
      stdout: "",
      stderr: `No compatible shell executable was found for platform ${opts.platform}.`,
      exitCode: 1,
      errorCode: "ENOENT",
      sandbox: "none",
      sandboxWarning: transformed?.warning,
    };
  } finally {
    if (tempScript) {
      try {
        fsSync.unlinkSync(tempScript.path);
      } catch {
        // Best-effort cleanup; the OS temp dir is the backstop.
      }
    }
  }
}

function buildBashToolDescription(platform: NodeJS.Platform = hostPlatform()): string {
  // Single-dialect: the model sees only THIS host's shell rules, rendered from
  // the same module that owns execution (src/platform/shell.ts).
  return `Execute a shell command. Use for git, npm, docker, system operations, and anything requiring the shell.

${shellPromptGuidance({ platform })}

IMPORTANT: Prefer dedicated tools over bash equivalents:
- Reading files: use read (not cat/head/tail)
- Writing files: use write (not echo > / tee)
- Editing files: use edit (not sed/awk)
- Finding files: use glob (not find/ls)
- Searching content: use grep (not grep/rg)

Rules:
- Always quote file paths containing spaces with double quotes
- Prefer absolute paths; avoid cd
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
          yolo: ctx.yolo,
        });
      const preExecClassification = classifyCommandDetailed(command);
      if (!preExecClassification.autoApprove && !(await ctx.approveCommand(command))) {
        const res = {
          stdout: "",
          stderr: "Command was not approved.",
          exitCode: 1,
        };
        ctx.log(`tool< bash ${JSON.stringify(res)}`);
        return res;
      }
      const runner = runShellCommandOverrideForTests ?? runShellCommand;
      // Read-only/no-project-write roles and scoped children (targetPaths) are
      // hard floors: their write/scope guarantee must be ENFORCED by the backend,
      // never just process-contained or relaxed to an unsandboxed run. They fail
      // closed unless an enforcing backend (Seatbelt/bwrap) is available. Only an
      // unscoped workspace-write session may take the approved unsandboxed fallback.
      const isHardFloor =
        policy.kind === "read-only" ||
        policy.kind === "no-project-write" ||
        (ctx.agentTargetPaths?.length ?? 0) > 0;
      // An explicitly configured network ban is a floor YOLO must not silently
      // widen: approvals auto-return true under YOLO, so the unsandboxed
      // fallback below would otherwise run a no-network command WITH network
      // access on a host without an enforcing backend. Require the backend to
      // enforce the ban and fail closed when it cannot (YOLO never prompts).
      const yoloEnforcedNetworkBan = ctx.yolo === true && !policyAllowsNetwork(policy);
      const baseArgs = {
        command,
        cwd: ctx.config.workingDirectory,
        abortSignal: ctx.abortSignal,
        timeoutMs,
        env: ctx.toolEnv,
        requireBackend: sandboxConfig.requireBackend,
        requireEnforcingBackend: isHardFloor || yoloEnforcedNetworkBan,
        // Prompt before running unsandboxed when no backend is available. This
        // is still a sandbox escape, so label it with the sandbox-denied reason
        // used by the approval layer's protected escalation path.
        approveUnsandboxed: () =>
          ctx.approveCommand(command, {
            reason: "sandbox_denied",
            detail:
              "No enforcing OS sandbox is available on this machine, so this command can only run with full filesystem and network access.",
          }),
        assertCanMutate: async () => {
          await ctx.assertCanMutate?.("bash");
        },
      };

      await ctx.assertCanMutate?.("bash");
      let result = await runner({ ...baseArgs, policy });
      if (result.sandboxWarning) {
        ctx.log(`tool> bash sandbox unavailable: ${result.sandboxWarning}`);
      }

      // Escalate-on-failure: when a sandboxed command fails in a way that looks
      // like a sandbox denial, ask the user whether to retry with the blocked
      // capability widened.
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
        // Classify the denial so the client can render a tailored, sandbox-aware
        // escalation ("blocked a write" vs "blocked network access") instead of a
        // generic command-approval prompt.
        const category = classifySandboxDenial(result, { networkRestricted }) ?? "filesystem";
        const approved = await ctx.approveCommand(command, {
          reason: "sandbox_denied",
          category,
          detail: describeSandboxDenial(category),
        });
        if (approved) {
          const retryPolicy: SandboxPolicy =
            category === "network"
              ? { ...policy, network: true }
              : { kind: "danger-full-access", network: policy.network };
          await ctx.assertCanMutate?.("bash");
          result = await runner({ ...baseArgs, policy: retryPolicy });
        }
      }

      // Surface the sandbox warning in the command output (not just logs) so the
      // model/user can see enforcement was degraded. Excluded for the fail-closed
      // case, which already explains itself. If a partial backend ever ran the
      // command, do not claim it ran without a sandbox; show its warning verbatim.
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
  minimalSandboxEnv,
  runShellCommandWithExec,
  setRunShellCommandForTests(runner: (opts: RunShellCommandOpts) => Promise<ShellRunResult>) {
    runShellCommandOverrideForTests = runner;
  },
  resetRunShellCommandForTests() {
    runShellCommandOverrideForTests = null;
  },
};
