/**
 * Heuristic detection of "this command failed because the sandbox blocked it"
 * versus a normal command failure. Drives the escalate-on-failure flow: when a
 * sandboxed command looks denied, the agent may prompt the user to retry it
 * without the sandbox. Mirrors Codex's `is_likely_sandbox_denied`
 * (`codex-rs/core/src/exec.rs`).
 */

export interface SandboxDeniedInput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const SANDBOX_DENIAL_MARKERS = [
  "operation not permitted",
  "permission denied",
  "read-only file system",
  "failed to write",
  "could not write",
  "cannot create",
  "seccomp",
  "landlock",
  "sandbox",
] as const;

/**
 * Exit codes that almost always indicate a non-sandbox failure (e.g. command
 * not found, not executable, or a clean exit), so we never treat them as a
 * sandbox denial.
 */
const NON_SANDBOX_EXIT_CODES = new Set([0, 126, 127]);

export function isLikelySandboxDenied(output: SandboxDeniedInput): boolean {
  if (NON_SANDBOX_EXIT_CODES.has(output.exitCode)) return false;
  const haystack = `${output.stdout}\n${output.stderr}`.toLowerCase();
  return SANDBOX_DENIAL_MARKERS.some((marker) => haystack.includes(marker));
}
