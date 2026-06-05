import path from "node:path";

import type { SandboxPolicy } from "./policy";

/**
 * Windows sandbox generation. Unlike macOS/Linux there is no system sandbox
 * wrapper to call, so this module builds the command line for a bundled native helper
 * (`cowork-win-sandbox.exe`, see `crates/cowork-win-sandbox/`) that applies a
 * restricted token + Job Object before spawning the command. The helper is not
 * currently selected by {@link SandboxManager} for restrictive policies because
 * it does not yet enforce per-root filesystem scoping or WFP network isolation.
 *
 * Modeled on the restricted-token path of Codex's `windows-sandbox-rs`. Network
 * isolation (Codex's WFP layer) is intentionally out of scope for v1, so the
 * `--allow-network` flag is informational and not yet enforced.
 */

export const WINDOWS_SANDBOX_HELPER_NAME = "cowork-win-sandbox.exe";

export interface WindowsSandboxCommand {
  file: string;
  args: string[];
}

/**
 * Build the helper invocation that wraps `inner`. Returns
 * `{ file: helperPath, args: ["--mode", ..., "--writable-root", ..., "--cwd",
 * cwd, ("--allow-network"?), "--", inner.file, ...inner.args] }`.
 */
export function buildWindowsSandboxCommand(
  inner: WindowsSandboxCommand,
  policy: SandboxPolicy,
  cwd: string,
  helperPath: string,
): WindowsSandboxCommand {
  if (policy.kind === "danger-full-access") {
    // Caller should not sandbox in this mode; return the command unchanged.
    return inner;
  }

  const args: string[] = ["--mode", policy.kind];

  if (policy.kind === "workspace-write") {
    for (const root of policy.writableRoots) {
      args.push("--writable-root", path.resolve(root));
    }
  }

  args.push("--cwd", path.resolve(cwd));
  if (policy.network) args.push("--allow-network");

  args.push("--", inner.file, ...inner.args);

  return { file: helperPath, args };
}
