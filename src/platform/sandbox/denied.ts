/**
 * Heuristic detection of "this command failed because the sandbox blocked it"
 * versus a normal command failure. Drives the escalate-on-failure flow: when a
 * sandboxed command looks denied, the agent may prompt the user to retry it
 * without the sandbox. Mirrors Codex's `is_likely_sandbox_denied`
 * (`codex-rs/core/src/exec.rs`).
 */

import type { SandboxDenialCategory } from "../../types";

export interface SandboxDeniedInput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Specific signals of an OS-sandbox denial. Kept narrow on purpose: a bare
// "sandbox" substring matched unrelated output (test names, docs, CLI messages)
// and spuriously triggered the escalate-on-failure prompt. These mirror Codex's
// `is_likely_sandbox_denied`.
const SANDBOX_DENIAL_MARKERS = [
  "operation not permitted",
  "permission denied",
  "access is denied", // Windows restricted-token / ACL denials
  "read-only file system",
  "seccomp",
  "landlock",
] as const;

/**
 * Network-isolation failures surface as connectivity/DNS errors, not the
 * filesystem markers above. These are only treated as denials when the policy
 * actually restricts network (otherwise they are real network errors).
 */
const NETWORK_DENIAL_MARKERS = [
  "network is unreachable",
  "network is down",
  "could not resolve host",
  "temporary failure in name resolution",
  "name or service not known",
  "no address associated with hostname",
] as const;

/**
 * Exit codes that almost always indicate a non-sandbox failure (e.g. command
 * not found, not executable, or a clean exit), so we never treat them as a
 * sandbox denial.
 */
const NON_SANDBOX_EXIT_CODES = new Set([0, 126, 127]);

const NON_SANDBOX_FAILURE_MARKERS = [
  "permission denied (publickey)",
  "permission denied, please try again",
  "authentication failed",
  "fatal: could not read from remote repository",
  "publickey,password",
  "403 forbidden",
  // Ordinary OS/tooling permission errors that are NOT sandbox denials —
  // escalating to full access would not fix them and the prompt is just noise.
  "permission denied while trying to connect to the docker daemon",
  "npm err! code eacces",
  "eacces: permission denied, mkdir",
  "sudo: a terminal is required",
  "sudo: a password is required",
] as const;

function hasNonSandboxFailureMarker(haystack: string): boolean {
  return NON_SANDBOX_FAILURE_MARKERS.some((marker) => haystack.includes(marker));
}

export function isLikelySandboxDenied(
  output: SandboxDeniedInput,
  opts?: { networkRestricted?: boolean },
): boolean {
  if (NON_SANDBOX_EXIT_CODES.has(output.exitCode)) return false;
  const haystack = `${output.stdout}\n${output.stderr}`.toLowerCase();
  if (hasNonSandboxFailureMarker(haystack)) return false;
  if (SANDBOX_DENIAL_MARKERS.some((marker) => haystack.includes(marker))) return true;
  // When network is restricted by policy, namespace isolation failures look like
  // network errors; treat those as denials so the escalation prompt can offer
  // the documented retry-with-network path.
  if (opts?.networkRestricted && NETWORK_DENIAL_MARKERS.some((m) => haystack.includes(m))) {
    return true;
  }
  return false;
}

/**
 * Classify the kind of sandbox denial so the escalation UI can show tailored
 * copy ("blocked a filesystem write" vs "blocked network access"). Returns
 * `null` when the failure does not look like a sandbox denial. Filesystem
 * markers take precedence over network markers.
 */
export function classifySandboxDenial(
  output: SandboxDeniedInput,
  opts?: { networkRestricted?: boolean },
): SandboxDenialCategory | null {
  if (NON_SANDBOX_EXIT_CODES.has(output.exitCode)) return null;
  const haystack = `${output.stdout}\n${output.stderr}`.toLowerCase();
  if (hasNonSandboxFailureMarker(haystack)) return null;
  if (SANDBOX_DENIAL_MARKERS.some((marker) => haystack.includes(marker))) return "filesystem";
  if (opts?.networkRestricted && NETWORK_DENIAL_MARKERS.some((m) => haystack.includes(m))) {
    return "network";
  }
  return null;
}

/**
 * Short, human-readable explanation of a sandbox denial for the approval UI.
 * Kept generic (no raw command output) so it is safe to surface verbatim.
 */
export function describeSandboxDenial(category: SandboxDenialCategory): string {
  return category === "network"
    ? "The OS sandbox blocked network access for this command."
    : "The OS sandbox blocked a write outside the workspace for this command.";
}
