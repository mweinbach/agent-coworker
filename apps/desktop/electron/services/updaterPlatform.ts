type UpdaterPlatformClient = {
  disableDifferentialDownload?: boolean;
};

export function applyUpdaterPlatformDefaults(
  updater: UpdaterPlatformClient,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin") {
    // ShipIt can reject a differential-patched app even when the published zip
    // is validly signed and notarized. Prefer the known-good full zip path.
    updater.disableDifferentialDownload = true;
  }
}
