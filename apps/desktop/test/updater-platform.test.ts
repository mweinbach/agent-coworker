import { describe, expect, test } from "bun:test";

import { applyUpdaterPlatformDefaults } from "../electron/services/updaterPlatform";

describe("desktop updater platform defaults", () => {
  test("disables differential downloads on macOS", () => {
    const updater: { disableDifferentialDownload?: boolean; channel?: string | null } = {};

    applyUpdaterPlatformDefaults(updater, "darwin", "arm64");

    expect(updater.disableDifferentialDownload).toBe(true);
    expect(updater.channel).toBeUndefined();
  });

  test("routes windows arm64 updates to the dedicated channel", () => {
    const updater: { disableDifferentialDownload?: boolean; channel?: string | null } = {};

    applyUpdaterPlatformDefaults(updater, "win32", "arm64");

    expect(updater.channel).toBe("latest-arm64");
    expect(updater.disableDifferentialDownload).toBeUndefined();
  });

  test("keeps windows x64 on the default latest.yml channel", () => {
    const updater: { disableDifferentialDownload?: boolean; channel?: string | null } = {};

    applyUpdaterPlatformDefaults(updater, "win32", "x64");

    expect(updater.channel).toBeUndefined();
  });
});
