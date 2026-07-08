export type PlatformId = NodeJS.Platform;

/**
 * The only sanctioned read of process.platform outside default parameters.
 *
 * Every platform-branching function in src/platform accepts an explicit
 * `platform?: NodeJS.Platform` and defaults it to `hostPlatform()`, so all
 * branches are unit-testable on every host. Callers outside src/platform must
 * never read process.platform directly (enforced by test/platform-boundary).
 */
export function hostPlatform(): NodeJS.Platform {
  return process.platform;
}

export type DesktopPlatform = "windows" | "macos" | "linux" | "other";

/**
 * Single raw→normalized platform vocabulary mapping for UI-facing code
 * (replaces the byte-identical copies in apps/desktop/src/lib/desktopPlatform.ts
 * and apps/desktop/electron/services/windowChrome/platformChrome.ts).
 */
export function toDesktopPlatform(platform: NodeJS.Platform = hostPlatform()): DesktopPlatform {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}
