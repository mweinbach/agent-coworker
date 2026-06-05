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

/** Locate the `bwrap` executable on PATH, or `null` if not installed. */
export function findBwrap(env: NodeJS.ProcessEnv = process.env): string | null {
  const rawPath = env.PATH;
  if (!rawPath) return null;
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "bwrap");
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable PATH entries
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
  const override = env.COWORK_WIN_SANDBOX_HELPER;
  if (override) {
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
