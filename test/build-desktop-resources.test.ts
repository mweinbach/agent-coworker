import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __internal } from "../scripts/build_desktop_resources";

describe("desktop resource build helpers", () => {
  test("soft-disables optional Windows AI Electron packaging when the addon is absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
    const dest = path.join(root, "apps", "desktop", "resources", "binaries", "windows-ai-electron");

    try {
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, "stale.txt"), "stale");

      const inputs = await __internal.ensureWindowsAiElectronInputs(root, "win32", "x64");
      expect(inputs).toBeNull();

      await __internal.syncWindowsAiElectronPackage({
        root,
        dest,
        previousFingerprint: null,
        nextFingerprint: null,
        platform: "win32",
        arch: "x64",
      });

      await expect(fs.stat(dest)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
