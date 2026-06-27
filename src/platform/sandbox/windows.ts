import os from "node:os";
import path from "node:path";

import type { SandboxPolicy } from "./policy";

/**
 * Windows sandbox generation. Unlike macOS/Linux there is no system sandbox
 * wrapper to call, so this module builds the command line for a bundled native helper
 * (`cowork-win-sandbox.exe`, see `crates/cowork-win-sandbox/`) that applies a
 * dedicated restricted identities, capability-SID ACLs, WFP network rules, a
 * restricted token, and a kill-on-close Job Object before spawning the command.
 * The helper's native probe must prove every policy dimension before
 * {@link SandboxManager} treats it as enforcing.
 */

export const WINDOWS_SANDBOX_HELPER_NAME = "cowork-win-sandbox.exe";
export const WINDOWS_SANDBOX_SETUP_NAME = "codex-windows-sandbox-setup.exe";
export const WINDOWS_SANDBOX_COMMAND_RUNNER_NAME = "codex-command-runner.exe";
export const WINDOWS_SANDBOX_HASH_MANIFEST_NAME = "cowork-win-sandbox.sha256.json";

export interface WindowsSandboxCommand {
  file: string;
  args: string[];
}

/**
 * Build the helper invocation that wraps `inner`. Returns
 * `{ file: helperPath, args: ["run", "--mode", ..., "--writable-root", ..., "--cwd",
 * cwd, ("--allow-network"?), "--", inner.file, ...inner.args] }`.
 */
export function buildWindowsSandboxCommand(
  inner: WindowsSandboxCommand,
  policy: SandboxPolicy,
  cwd: string,
  helperPath: string,
  sandboxHome = path.join(os.homedir(), ".cowork"),
): WindowsSandboxCommand {
  const helperMode =
    policy.kind === "danger-full-access"
      ? "network-only"
      : policy.kind === "no-project-write"
        ? "read-only"
        : policy.kind;
  const args: string[] = ["run", "--mode", helperMode, "--sandbox-home", path.resolve(sandboxHome)];

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
