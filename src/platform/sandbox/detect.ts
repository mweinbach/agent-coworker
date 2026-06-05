import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { MACOS_SEATBELT_EXECUTABLE } from "./seatbelt";
import { WINDOWS_SANDBOX_HELPER_NAME } from "./windows";

/**
 * Runtime capability probes for the available sandbox backends. Kept separate
 * from the {@link SandboxManager} so they can be injected/mocked in tests.
 */

/** Whether `/usr/bin/sandbox-exec` exists (macOS Seatbelt). */
export function hasSeatbelt(): boolean {
  try {
    return fs.existsSync(MACOS_SEATBELT_EXECUTABLE);
  } catch {
    return false;
  }
}

/**
 * Trusted absolute locations to look for `bwrap`. We deliberately do NOT search
 * `$PATH`: a workspace-write command could plant an executable at a
 * workspace-controlled PATH entry (e.g. `node_modules/.bin/bwrap`) and, since
 * that wrapper runs as `argv[0]` of the next bash call, escape the sandbox. Only
 * root-owned system directories (or an explicit `COWORK_BWRAP_PATH`) are trusted.
 */
const TRUSTED_BWRAP_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/usr/sbin",
  "/sbin",
  "/run/current-system/sw/bin", // NixOS
];

const bwrapUsabilityCache = new Map<string, boolean>();

/**
 * Whether `bwrap` at `program` can actually create the namespaces the sandbox
 * relies on. On hosts where bubblewrap is installed but unprivileged user
 * namespaces are disabled, the binary exists yet every `--unshare-user`
 * invocation fails — so the backend is effectively unavailable and commands
 * would error during sandbox setup instead of taking the configured
 * fail-closed/fallback path. Probes a trivial namespace command once and caches
 * the result (host capability is stable for the process lifetime).
 */
export function isBwrapUsable(program: string): boolean {
  const cached = bwrapUsabilityCache.get(program);
  if (cached !== undefined) return cached;
  let usable = false;
  try {
    const probe = spawnSync(
      program,
      [
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--unshare-user",
        "--unshare-pid",
        "--proc",
        "/proc",
        "/bin/true",
      ],
      { timeout: 10_000, stdio: "ignore" },
    );
    usable = probe.status === 0;
  } catch {
    usable = false;
  }
  bwrapUsabilityCache.set(program, usable);
  return usable;
}

/** Locate the `bwrap` executable in a trusted system location, or `null`. */
export function findBwrap(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.COWORK_BWRAP_PATH;
  if (override && path.isAbsolute(override)) {
    try {
      if (fs.existsSync(override)) return override;
    } catch {
      // fall through to the trusted-dir search
    }
  }
  for (const dir of TRUSTED_BWRAP_DIRS) {
    const candidate = path.join(dir, "bwrap");
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable directories
    }
  }
  return null;
}

/**
 * Locate the bundled Windows sandbox helper (`cowork-win-sandbox.exe`).
 * Honors the `COWORK_WIN_SANDBOX_HELPER` override first, then searches the
 * provided candidate directories (typically the app resources dir and the
 * directory next to the running binary).
 */
export function findWindowsHelper(
  candidateDirs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // Require an absolute override path (like COWORK_BWRAP_PATH) so a relative
  // value can't resolve a workspace-controlled executable as the sandbox wrapper.
  const override = env.COWORK_WIN_SANDBOX_HELPER;
  if (override && path.isAbsolute(override)) {
    try {
      if (fs.existsSync(override)) return override;
    } catch {
      // fall through to candidate search
    }
  }
  for (const dir of candidateDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, WINDOWS_SANDBOX_HELPER_NAME);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}
