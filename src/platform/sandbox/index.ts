import path from "node:path";

import { buildBwrapCommand } from "./bwrap";
import { findBwrap, findWindowsHelper, hasSeatbelt, isBwrapUsable } from "./detect";
import type { SandboxPolicy } from "./policy";
import { buildSeatbeltCommand } from "./seatbelt";
import { buildWindowsSandboxCommand } from "./windows";

export { classifySandboxDenial, describeSandboxDenial, isLikelySandboxDenied } from "./denied";
export type { SandboxConfig, SandboxMode, SandboxPolicy } from "./policy";
export {
  DEFAULT_SANDBOX_CONFIG,
  deriveWritableRoots,
  policyAllowsNetwork,
  resolveSandboxPolicy,
} from "./policy";

/** Concrete sandbox backend selected for a given platform + policy. */
export type SandboxType = "none" | "macos-seatbelt" | "linux-bwrap" | "windows-restricted";

/** Marker env var set on sandboxed children (mirrors Codex's `CODEX_SANDBOX`). */
export const SANDBOX_ENV_VAR = "COWORK_SANDBOX";
/** Set to "1" on children whose network access is restricted. */
export const SANDBOX_NETWORK_DISABLED_ENV_VAR = "COWORK_SANDBOX_NETWORK_DISABLED";

/** Available sandbox backends. Injectable so tests are platform-independent. */
export interface SandboxCapabilities {
  seatbelt: boolean;
  bwrapPath: string | null;
  windowsHelperPath: string | null;
}

export interface SandboxCommand {
  file: string;
  args: string[];
}

export interface SandboxTransformInput extends SandboxCommand {
  policy: SandboxPolicy;
  cwd: string;
  platform?: NodeJS.Platform;
  capabilities?: SandboxCapabilities;
}

export interface SandboxTransformResult extends SandboxCommand {
  /** Marker environment variables to merge into the child's environment. */
  env: Record<string, string>;
  /** The backend that was applied (`"none"` when not sandboxed). */
  sandbox: SandboxType;
  /** True when no OS sandbox wraps the command (full-access or unavailable). */
  unsandboxed: boolean;
  /**
   * Whether the selected backend actually ENFORCES the policy's filesystem/scope
   * (true for Seatbelt/bwrap). The Windows restricted-token helper provides only
   * process containment (no per-root FS/WFP scoping), so it is NOT enforcing —
   * hard-floor contexts (read-only roles, scoped children) must fail closed
   * rather than run unenforced under it. Absent means non-enforcing.
   */
  enforcesScope?: boolean;
  /** Set when sandboxing was wanted but unavailable on this platform. */
  warning?: string;
}

/**
 * Default directories to search for the bundled Windows sandbox helper: next to
 * the running binary and the Electron `resources` dir. The
 * `COWORK_WIN_SANDBOX_HELPER` env override (handled in `findWindowsHelper`)
 * takes precedence over these.
 */
function defaultWindowsHelperDirs(): string[] {
  const dirs: string[] = [];
  try {
    if (process.execPath) dirs.push(path.dirname(process.execPath));
  } catch {
    // process.execPath may be unavailable in some embeddings
  }
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) dirs.push(resourcesPath);
  return dirs;
}

/** Probe the host for available sandbox backends. */
export function detectCapabilities(
  platform: NodeJS.Platform = process.platform,
  windowsHelperDirs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): SandboxCapabilities {
  const winDirs = windowsHelperDirs.length > 0 ? windowsHelperDirs : defaultWindowsHelperDirs();
  // Treat an installed-but-unusable bwrap (no unprivileged user namespaces) as
  // unavailable, so the configured requireBackend fail-closed/fallback applies
  // instead of running commands that error during sandbox setup.
  const bwrapFound = platform === "linux" ? findBwrap(env) : null;
  return {
    seatbelt: platform === "darwin" ? hasSeatbelt() : false,
    bwrapPath: bwrapFound && isBwrapUsable(bwrapFound) ? bwrapFound : null,
    windowsHelperPath: platform === "win32" ? findWindowsHelper(winDirs, env) : null,
  };
}

/**
 * Translate a platform-agnostic {@link SandboxPolicy} into a concrete sandboxed
 * command. This is the single abstraction every platform flows through: it
 * picks the backend, prepends the appropriate wrapper to `{ file, args }`, and
 * returns the marker env to attach to the child. Mirrors Codex's
 * `SandboxManager::transform`.
 */
export class SandboxManager {
  transform(input: SandboxTransformInput): SandboxTransformResult {
    const inner: SandboxCommand = { file: input.file, args: input.args };

    // Full filesystem + network access: never wrap, no warning (this is an
    // explicit choice). Return BEFORE probing capabilities — detectCapabilities()
    // may synchronously probe bwrap usability, which is wasted work for a command
    // that will not be sandboxed. A danger-full-access policy with network:false
    // still needs a network-only sandbox wrapper below.
    if (input.policy.kind === "danger-full-access" && input.policy.network !== false) {
      return { ...inner, env: {}, sandbox: "none", unsandboxed: true };
    }

    const platform = input.platform ?? process.platform;
    const capabilities = input.capabilities ?? detectCapabilities(platform);
    const networkRestricted =
      input.policy.kind === "danger-full-access"
        ? input.policy.network === false
        : !input.policy.network;
    const markerEnv = (sandbox: SandboxType): Record<string, string> => {
      const env: Record<string, string> = {};
      if (sandbox !== "none") env[SANDBOX_ENV_VAR] = sandbox;
      if (networkRestricted) env[SANDBOX_NETWORK_DISABLED_ENV_VAR] = "1";
      return env;
    };

    const unavailable = (warning: string): SandboxTransformResult => ({
      ...inner,
      env: markerEnv("none"),
      sandbox: "none",
      unsandboxed: true,
      warning,
    });

    switch (platform) {
      case "darwin": {
        if (!capabilities.seatbelt) {
          return unavailable("macOS Seatbelt unavailable (/usr/bin/sandbox-exec not found)");
        }
        const wrapped = buildSeatbeltCommand(inner, input.policy);
        return {
          ...wrapped,
          env: markerEnv("macos-seatbelt"),
          sandbox: "macos-seatbelt",
          unsandboxed: false,
          enforcesScope: true,
        };
      }
      case "linux": {
        if (!capabilities.bwrapPath) {
          return unavailable(
            "Linux sandbox unavailable: `bwrap` not found in a trusted system dir " +
              "(install bubblewrap to /usr/bin or set COWORK_BWRAP_PATH to an absolute path)",
          );
        }
        const wrapped = buildBwrapCommand(inner, input.policy, input.cwd, {
          program: capabilities.bwrapPath,
        });
        return {
          ...wrapped,
          env: markerEnv("linux-bwrap"),
          sandbox: "linux-bwrap",
          unsandboxed: false,
          enforcesScope: true,
        };
      }
      case "win32": {
        if (!capabilities.windowsHelperPath) {
          return unavailable("Windows sandbox helper (cowork-win-sandbox.exe) not found");
        }
        const wrapped = buildWindowsSandboxCommand(
          inner,
          input.policy,
          input.cwd,
          capabilities.windowsHelperPath,
        );
        return {
          ...wrapped,
          env: markerEnv("windows-restricted"),
          sandbox: "windows-restricted",
          unsandboxed: false,
          // The helper applies a restricted (LUA) token + kill-on-close Job Object
          // (process containment), but per-root filesystem ACL scoping and WFP
          // network isolation are not yet implemented — so workspace-write /
          // read-only path scoping is NOT enforced here. Surface that clearly.
          warning:
            "Windows helper applies restricted-token + Job Object containment only; " +
            "filesystem and network scoping are not yet enforced.",
        };
      }
      default:
        return unavailable(`No sandbox backend available for platform "${platform}"`);
    }
  }
}

/** Shared default manager instance. */
export const sandboxManager = new SandboxManager();
