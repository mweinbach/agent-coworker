export const ANTIGRAVITY_SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];

export const ANTIGRAVITY_UNSUPPORTED_PLATFORM_MESSAGE =
  "Antigravity runtime is only supported on macOS and Linux for now.";

export function isAntigravitySupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return ANTIGRAVITY_SUPPORTED_PLATFORMS.includes(platform);
}

export function assertAntigravitySupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): void {
  if (!isAntigravitySupportedPlatform(platform)) {
    throw new Error(ANTIGRAVITY_UNSUPPORTED_PLATFORM_MESSAGE);
  }
}
