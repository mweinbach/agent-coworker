import path from "node:path";

import { coworkHome } from "../paths";
import {
  canonicalizeRoot,
  policyAllowsNetwork,
  type SandboxPolicy,
  scratchRoots,
  tmpScratchRoots,
} from "./policy";

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
 * THE single resolver for the Windows sandbox home directory, shared by
 * `detect.ts` (probe/setup) and `buildWindowsSandboxCommand` callers so every
 * layer agrees on one home. Contract (all platforms — no host branching):
 * `COWORK_WIN_SANDBOX_HOME` (trimmed, when non-empty) else
 * `paths.coworkHome(env)` (`~/.cowork`, honoring `COWORK_HOME_OVERRIDE` and the
 * no-HOME-on-Windows rule). The result is always `path.resolve`d.
 */
export function windowsSandboxHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COWORK_WIN_SANDBOX_HOME?.trim();
  return path.resolve(override || coworkHome(env));
}

/**
 * Build the helper invocation that wraps `inner`. Returns
 * `{ file: helperPath, args: ["run", "--mode", ..., "--writable-root", ..., "--cwd",
 * cwd, ("--allow-network"?), "--", inner.file, ...inner.args] }`.
 *
 * Per-policy contract (parity with the bwrap/Seatbelt backends):
 * - `workspace-write` → helper mode `workspace-write` with the policy's
 *   writable roots. (The helper natively also permits the host TEMP root in
 *   this mode, matching the POSIX backends' `/tmp` scratch.)
 * - `no-project-write` → helper mode `workspace-write` with ONLY the
 *   {@link scratchRoots} temp dirs writable, mirroring the mac/Linux temp
 *   scratch that read-only roles get ("They still get temp scratch space").
 *   The former mapping to helper mode `read-only` silently dropped scratch on
 *   Windows only. When the project itself lives under the temp root,
 *   {@link tmpScratchRoots} yields no scratch and the helper falls back to
 *   mode `read-only` — never to the helper's implicit cwd-writable default.
 * - `read-only` → helper mode `read-only`, nothing writable. An explicit
 *   read-only policy is fully immutable on every platform (it gets no temp
 *   scratch on macOS/Linux either), so Windows must not widen it.
 * - `danger-full-access` → helper mode `network-only` (the helper refuses an
 *   unrestricted filesystem profile; this arm only exists for network-off
 *   full access, see `SandboxManager.transform`).
 *
 * The network flag uses {@link policyAllowsNetwork}, so a
 * `danger-full-access` policy without an explicit `network: false` correctly
 * gets `--allow-network` (raw `policy.network` is `undefined` there — the
 * latent inversion this replaces).
 *
 * `sandboxHome` is required; callers resolve it once via
 * {@link windowsSandboxHome} (or the probed capability value) so the build and
 * detect layers can never disagree about the home.
 */
export function buildWindowsSandboxCommand(
  inner: WindowsSandboxCommand,
  policy: SandboxPolicy,
  cwd: string,
  helperPath: string,
  sandboxHome: string,
): WindowsSandboxCommand {
  // Scratch-only writable roots for no-project-write; excludes any scratch dir
  // that is an ancestor of a project root so a TEMP-resident project can't get
  // its own tree back as "scratch". Scratch dirs are canonicalized first
  // (matching the bwrap backend's canonical binds) so the ancestor comparison
  // holds even when %TEMP% is spelled as an 8.3 short path.
  const scratch =
    policy.kind === "no-project-write"
      ? tmpScratchRoots(policy.projectRoots ?? [], scratchRoots("win32").map(canonicalizeRoot))
      : [];
  const helperMode =
    policy.kind === "danger-full-access"
      ? "network-only"
      : policy.kind === "no-project-write"
        ? scratch.length > 0
          ? "workspace-write"
          : "read-only"
        : policy.kind;
  const args: string[] = ["run", "--mode", helperMode, "--sandbox-home", path.resolve(sandboxHome)];

  const writableRoots = policy.kind === "workspace-write" ? policy.writableRoots : scratch;
  for (const root of writableRoots) {
    args.push("--writable-root", path.resolve(root));
  }

  args.push("--cwd", path.resolve(cwd));
  if (policyAllowsNetwork(policy)) args.push("--allow-network");

  args.push("--", inner.file, ...inner.args);

  return { file: helperPath, args };
}
