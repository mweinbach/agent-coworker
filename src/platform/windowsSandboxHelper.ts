import fs from "node:fs";
import path from "node:path";

/**
 * File names of the bundled Windows sandbox executables (built from
 * `crates/cowork-win-sandbox/` and the Rust command runner). The Rust server's
 * `cowork-sandbox` crate drives them at runtime; Electron and the build scripts
 * only need to locate, copy and hash them.
 */
export const WINDOWS_SANDBOX_HELPER_NAME = "cowork-win-sandbox.exe";
export const WINDOWS_SANDBOX_SETUP_NAME = "codex-windows-sandbox-setup.exe";
export const WINDOWS_SANDBOX_COMMAND_RUNNER_NAME = "codex-command-runner.exe";
export const WINDOWS_SANDBOX_HASH_MANIFEST_NAME = "cowork-win-sandbox.sha256.json";

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
  // Require an absolute override path so a relative value can't resolve a
  // workspace-controlled executable as the sandbox wrapper.
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
