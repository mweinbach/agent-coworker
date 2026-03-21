type UpdaterPlatformClient = {
  disableDifferentialDownload?: boolean;
  channel?: string | null;
};

export function applyUpdaterPlatformDefaults(
  updater: UpdaterPlatformClient,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): void {
  if (platform === "darwin") {
    // ShipIt can reject a differential-patched app even when the published zip
    // is validly signed and notarized. Prefer the known-good full zip path.
    updater.disableDifferentialDownload = true;
  }

  if (platform === "win32" && arch === "arm64") {
    updater.channel = "latest-arm64";
  }
}
