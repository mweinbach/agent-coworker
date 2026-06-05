import path from "node:path";

import {
  canonicalizeRoot,
  PROTECTED_SUBPATH_NAMES,
  type SandboxPolicy,
  withTmpScratch,
} from "./policy";

/**
 * macOS Seatbelt sandbox generation. Ported from OpenAI Codex
 * (`codex-rs/sandboxing/src/seatbelt.rs` + `seatbelt_base_policy.sbpl`).
 *
 * We build a `.sbpl` policy string plus `-D KEY=path` parameter bindings and
 * run the command under `/usr/bin/sandbox-exec`. Path values are passed as
 * `-D` parameters (not interpolated into the policy text) so paths with spaces
 * or special characters cannot break the policy grammar.
 */

/**
 * Only ever invoke `sandbox-exec` from `/usr/bin` so an attacker cannot inject a
 * malicious `sandbox-exec` earlier on PATH. Mirrors Codex's
 * `MACOS_PATH_TO_SEATBELT_EXECUTABLE`.
 */
export const MACOS_SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";

/**
 * Closed-by-default base policy. Faithfully ported from Codex's
 * `seatbelt_base_policy.sbpl` (itself derived from Chromium's sandbox profile):
 * deny everything, then re-allow the minimum a normal CLI process needs
 * (exec/fork, signals to same-sandbox, ptys, /dev/null, harmless sysctls, and
 * the system lookups required for libc/CoreFoundation to start).
 */
const SEATBELT_BASE_POLICY = `(version 1)
(deny default)

; child processes inherit the policy of their parent
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))

(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; harmless, read-only sysctls used for CPU/host introspection
(allow sysctl-read)

; needed to look up user info
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo"))

; Needed for python multiprocessing (SemLock) and PyTorch/libomp on macOS
(allow ipc-posix-sem)
(allow ipc-posix-shm-read-data
  ipc-posix-shm-write-create
  ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))

(allow mach-lookup
  (global-name "com.apple.PowerManagement.control"))

; allow openpty() and interactive tty detection
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))

; allow read-only user preferences
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(allow mach-lookup
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (local-name "com.apple.cfprefsd.agent"))
(allow user-preference-read)`;

/**
 * Network rules appended after the base policy when network access is enabled.
 * Ported from Codex's `seatbelt_network_policy.sbpl` plus the broad
 * outbound/inbound allow that Codex uses when no proxy is configured.
 */
const SEATBELT_NETWORK_POLICY = `(allow network-outbound)
(allow network-inbound)
(allow system-socket)
(allow mach-lookup
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.networkd")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.ocspd"))`;

export interface SeatbeltCommand {
  file: string;
  args: string[];
}

interface DirParam {
  key: string;
  value: string;
}

/**
 * Build the full `sandbox-exec` invocation that wraps `inner`.
 *
 * Returns `{ file: "/usr/bin/sandbox-exec", args: ["-p", policy, "-DKEY=...",
 * ..., "--", inner.file, ...inner.args] }`.
 */
export function buildSeatbeltCommand(
  inner: SeatbeltCommand,
  policy: SandboxPolicy,
): SeatbeltCommand {
  const sections: string[] = [SEATBELT_BASE_POLICY];
  const params: DirParam[] = [];

  // Read access: Codex grants full-disk read in all sandboxed modes.
  sections.push("; allow read-only file operations\n(allow file-read*)");

  if (policy.kind === "workspace-write") {
    sections.push(buildWritePolicy(policy.writableRoots, params));
  }

  // `danger-full-access` never reaches here (handled as SandboxType.none).
  if (policy.kind !== "danger-full-access" && policy.network) {
    sections.push(SEATBELT_NETWORK_POLICY);
  }

  const policyText = sections.join("\n\n");

  const args: string[] = ["-p", policyText];
  for (const { key, value } of params) {
    args.push(`-D${key}=${value}`);
  }
  args.push("--", inner.file, ...inner.args);

  return { file: MACOS_SEATBELT_EXECUTABLE, args };
}

/**
 * Build the `(allow file-write* ...)` section for the writable roots, carving
 * out protected metadata subpaths (`.git`, `.cowork`) so they stay read-only
 * even though their parent root is writable.
 */
function buildWritePolicy(writableRoots: string[], params: DirParam[]): string {
  // Canonicalize the explicit roots (realpath) first so a symlinked root can't
  // grant writes to an unexpected target via a different logical path — matching
  // the Linux bwrap backend, which binds canonical paths. The /tmp scratch family
  // is added afterwards as literal paths; withTmpScratch skips a scratch dir that
  // would over-scope an explicit root under it (macOS /tmp↔/private/tmp aware).
  // Do NOT add cwd here; that would widen a child agent's scope beyond targetPaths.
  const roots = withTmpScratch(writableRoots.map(canonicalizeRoot), ["/tmp", "/private/tmp"]);

  const components: string[] = [];
  roots.forEach((root, index) => {
    const rootKey = `WRITABLE_ROOT_${index}`;
    params.push({ key: rootKey, value: root });

    const excluded: string[] = [];
    PROTECTED_SUBPATH_NAMES.forEach((name, subIndex) => {
      const subKey = `${rootKey}_EXCLUDED_${subIndex}`;
      params.push({ key: subKey, value: path.join(root, name) });
      excluded.push(
        `(require-not (subpath (param "${subKey}")))`,
        `(require-not (literal (param "${subKey}")))`,
      );
    });

    if (excluded.length === 0) {
      components.push(`(subpath (param "${rootKey}"))`);
    } else {
      components.push(`(require-all (subpath (param "${rootKey}")) ${excluded.join(" ")})`);
    }
  });

  return `(allow file-write*\n${components.join("\n")}\n)`;
}
