/**
 * Heuristic detection of "this command failed because the sandbox blocked it"
 * versus a normal command failure. Drives the escalate-on-failure flow: when a
 * sandboxed command looks denied, the agent may prompt the user to retry it
 * without the sandbox. Mirrors Codex's `is_likely_sandbox_denied`
 * (`codex-rs/core/src/exec.rs`).
 *
 * Marker tables are per platform FAMILY: a shared base (all existing POSIX +
 * generic Windows markers — unchanged, so POSIX behavior is identical) plus
 * win32-only additions for WinSock/.NET phrasings that only Windows children
 * emit. Callers may pass `opts.platform`; it defaults to the host.
 *
 * NOTE for the bash env layer (out of scope here): POSIX markers are
 * English-only, so `LC_MESSAGES=C` must be injected into sandboxed children
 * (via `env.minimalSandboxEnv`) so glibc/curl phrasings match regardless of
 * the user locale. Win32 additions are likewise English phrasings; localized
 * Windows output should eventually be keyed on Win32/WSA error codes.
 */

import type { SandboxDenialCategory } from "../../types";
import { hostPlatform } from "../host";

export interface SandboxDeniedInput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Extra context for the denial classifiers. */
export interface SandboxDeniedOptions {
  /** Whether the policy restricted network (network errors count as denials). */
  networkRestricted?: boolean;
  /** Platform whose marker table applies. Defaults to the host platform. */
  platform?: NodeJS.Platform;
}

/** A predicate over the lowercased combined stdout+stderr haystack. */
type DenialMatcher = (haystack: string) => boolean;

const includesMarker =
  (marker: string): DenialMatcher =>
  (haystack) =>
    haystack.includes(marker);

// Specific signals of an OS-sandbox denial. Kept narrow on purpose: a bare
// "sandbox" substring matched unrelated output (test names, docs, CLI messages)
// and spuriously triggered the escalate-on-failure prompt. These mirror Codex's
// `is_likely_sandbox_denied`. Applied on EVERY platform (unchanged base set).
const BASE_FILESYSTEM_DENIAL_MARKERS = [
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
 * Applied on EVERY platform (unchanged base set).
 */
const BASE_NETWORK_DENIAL_MARKERS = [
  "network is unreachable",
  "network is down",
  "could not resolve host",
  "temporary failure in name resolution",
  "name or service not known",
  "no address associated with hostname",
] as const;

const BASE_FILESYSTEM_MATCHERS: readonly DenialMatcher[] =
  BASE_FILESYSTEM_DENIAL_MARKERS.map(includesMarker);

const BASE_NETWORK_MATCHERS: readonly DenialMatcher[] =
  BASE_NETWORK_DENIAL_MARKERS.map(includesMarker);

/**
 * win32-only filesystem additions. .NET/PowerShell report ACL denials as
 * "Access to the path 'C:\x' is denied." — the path sits between the two
 * fragments, so this is a paired-substring match rather than one marker.
 */
const WIN32_FILESYSTEM_MATCHERS: readonly DenialMatcher[] = [
  ...BASE_FILESYSTEM_MATCHERS,
  (haystack) => haystack.includes("access to the path") && haystack.includes("is denied"),
];

/**
 * win32-only network additions: WinSock (WSAHOST_NOT_FOUND / WSAECONNREFUSED)
 * and .NET HttpClient phrasings that WFP-blocked children emit instead of the
 * glibc/curl wordings in the base table.
 */
const WIN32_NETWORK_DENIAL_MARKERS = [
  "no such host is known",
  "the remote name could not be resolved",
  "wsahost_not_found",
  "wsaeconnrefused",
  "no connection could be made because the target machine actively refused",
] as const;

const WIN32_NETWORK_MATCHERS: readonly DenialMatcher[] = [
  ...BASE_NETWORK_MATCHERS,
  ...WIN32_NETWORK_DENIAL_MARKERS.map(includesMarker),
];

/** Filesystem-denial matcher table for `platform` (base everywhere; +win32 extras on win32). */
function filesystemMatchers(platform: NodeJS.Platform): readonly DenialMatcher[] {
  return platform === "win32" ? WIN32_FILESYSTEM_MATCHERS : BASE_FILESYSTEM_MATCHERS;
}

/** Network-denial matcher table for `platform` (base everywhere; +win32 extras on win32). */
function networkMatchers(platform: NodeJS.Platform): readonly DenialMatcher[] {
  return platform === "win32" ? WIN32_NETWORK_MATCHERS : BASE_NETWORK_MATCHERS;
}

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
  // Ordinary permission errors that an unsandboxed retry would NOT fix, so the
  // escalation prompt is just noise. Kept narrow: a Docker daemon-socket denial
  // is a unix-group-membership issue, not a sandbox-scope one, so running with
  // full access does not help. (Bare EACCES on mkdir/npm is intentionally NOT
  // here — that IS typically a sandbox write-scope block that escalation fixes.)
  "permission denied while trying to connect to the docker daemon",
  "sudo: a terminal is required",
  "sudo: a password is required",
] as const;

function hasNonSandboxFailureMarker(haystack: string): boolean {
  return NON_SANDBOX_FAILURE_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Whether the failed command output looks like an OS-sandbox denial on
 * `opts.platform` (default: host). Identical to the historical behavior on
 * POSIX platforms; on win32 the WinSock/.NET marker additions also match.
 */
export function isLikelySandboxDenied(
  output: SandboxDeniedInput,
  opts?: SandboxDeniedOptions,
): boolean {
  return classifySandboxDenial(output, opts) !== null;
}

/**
 * Classify the kind of sandbox denial so the escalation UI can show tailored
 * copy ("blocked a filesystem write" vs "blocked network access"). Returns
 * `null` when the failure does not look like a sandbox denial. Filesystem
 * markers take precedence over network markers. Network markers only apply
 * when `opts.networkRestricted` is set (otherwise connectivity failures are
 * real network errors, not denials).
 */
export function classifySandboxDenial(
  output: SandboxDeniedInput,
  opts?: SandboxDeniedOptions,
): SandboxDenialCategory | null {
  if (NON_SANDBOX_EXIT_CODES.has(output.exitCode)) return null;
  const platform = opts?.platform ?? hostPlatform();
  const haystack = `${output.stdout}\n${output.stderr}`.toLowerCase();
  if (hasNonSandboxFailureMarker(haystack)) return null;
  if (filesystemMatchers(platform).some((matches) => matches(haystack))) return "filesystem";
  // When network is restricted by policy, namespace isolation failures look like
  // network errors; treat those as denials so the escalation prompt can offer
  // the documented retry-with-network path.
  if (opts?.networkRestricted && networkMatchers(platform).some((matches) => matches(haystack))) {
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
