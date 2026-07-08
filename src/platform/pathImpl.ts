import path from "node:path";

/** Loose record shape for injected environments (process.env-compatible). */
export type EnvRecord = Record<string, string | undefined>;

/**
 * The node:path implementation for a platform (win32 → path.win32, else
 * path.posix). Internal to src/platform — callers outside the layer use
 * pathString.ts (browser-safe) or paths.ts (filesystem-aware) instead.
 */
export function pathImplForPlatform(
  platform: NodeJS.Platform,
): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}
