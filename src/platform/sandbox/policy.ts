import path from "node:path";

/**
 * High-level sandbox policy, modeled on OpenAI Codex's `SandboxPolicy`
 * (`codex-rs/protocol/src/protocol.rs`). This is the platform-agnostic
 * description of what a shell command is allowed to do; each platform module
 * (`seatbelt.ts`, `bwrap.ts`, `windows.ts`) translates it into a concrete
 * sandbox invocation.
 */
export type SandboxPolicy =
  | { kind: "danger-full-access" }
  | { kind: "read-only"; network: boolean }
  | {
      kind: "workspace-write";
      /** Absolute roots the sandboxed process may write to (beyond temp dirs). */
      writableRoots: string[];
      network: boolean;
    };

/** User/role-facing configuration mode. `auto` resolves from role + working dirs. */
export type SandboxMode = "auto" | "read-only" | "workspace-write" | "danger-full-access";

export interface SandboxConfig {
  mode: SandboxMode;
  /** Outbound network access inside the sandbox. Defaults to `true`. */
  network?: boolean;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = { mode: "workspace-write", network: true };

/**
 * Metadata directory names that must remain read-only even when they live under
 * a writable root. Writing into `.git/hooks` or `.cowork` is a privilege
 * escalation vector, so these are carved back out of the writable set. Mirrors
 * Codex's `PROTECTED_METADATA_PATH_NAMES`.
 */
export const PROTECTED_SUBPATH_NAMES = [".git", ".cowork"] as const;

export interface ResolveSandboxPolicyInput {
  config?: SandboxConfig;
  /** Read-only role flag (explorer/research/reviewer). Forces read-only filesystem. */
  readOnlyRole?: boolean;
  workingDirectory: string;
  outputDirectory?: string;
  /** Child-agent enforced scope; when present these become the only writable roots. */
  targetPaths?: readonly string[] | null;
}

/**
 * Resolve a concrete {@link SandboxPolicy} from configuration, the agent role,
 * and the working directories. This is the single place that decides "what is
 * this command allowed to touch"; the OS sandbox then enforces it.
 */
export function resolveSandboxPolicy(input: ResolveSandboxPolicyInput): SandboxPolicy {
  const config = input.config ?? DEFAULT_SANDBOX_CONFIG;
  const network = config.network ?? true;

  // Read-only roles (explorer/reviewer/research) are a hard floor: they always
  // resolve to a read-only filesystem and are never escalated — even when the
  // configured mode is danger-full-access. This must be checked before the
  // danger-full-access short-circuit below.
  if (input.readOnlyRole || config.mode === "read-only") {
    return { kind: "read-only", network };
  }

  if (config.mode === "danger-full-access") {
    return { kind: "danger-full-access" };
  }

  // `workspace-write` and `auto` (for write-capable roles) both resolve here.
  return { kind: "workspace-write", writableRoots: deriveWritableRoots(input), network };
}

/**
 * Derive the absolute writable roots for a workspace-write policy. Child agents
 * with `targetPaths` are scoped strictly to those paths; otherwise the working
 * directory and output directory are writable.
 */
export function deriveWritableRoots(input: ResolveSandboxPolicyInput): string[] {
  const roots = new Set<string>();
  // Relative paths (e.g. a child's `targetPaths: ["src/auth"]`) must resolve
  // against the workspace, not the server process cwd.
  const base = input.workingDirectory;
  if (input.targetPaths && input.targetPaths.length > 0) {
    for (const p of input.targetPaths) roots.add(path.resolve(base, p));
  } else {
    roots.add(path.resolve(base));
    if (input.outputDirectory) roots.add(path.resolve(base, input.outputDirectory));
  }
  return [...roots];
}

/** Whether the policy permits outbound network access. */
export function policyAllowsNetwork(policy: SandboxPolicy): boolean {
  return policy.kind === "danger-full-access" || policy.network;
}
