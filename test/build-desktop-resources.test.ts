import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FOUNDATION_MODELS_KOFFI_TRIPLET } from "../apps/desktop/electron/services/sidecar";
import { __internal } from "../scripts/build_desktop_resources";

describe("desktop resource build helpers", () => {
  test("refreshes cached Foundation Models SDK bundles missing Koffi runtime files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
    const dest = path.join(root, "apps", "desktop", "resources", "binaries", "tsfm-sdk");
    const sdkRoot = path.join(root, "node_modules", "tsfm-sdk");
    const koffiRoot = path.join(root, "node_modules", "koffi");
    const nativeKoffiPath = path.join(
      koffiRoot,
      "build",
      "koffi",
      FOUNDATION_MODELS_KOFFI_TRIPLET,
      "koffi.node",
    );

    try {
      await fs.mkdir(path.join(sdkRoot, "dist"), { recursive: true });
      await fs.mkdir(path.join(sdkRoot, "native"), { recursive: true });
      await fs.mkdir(path.dirname(nativeKoffiPath), { recursive: true });
      await fs.writeFile(path.join(sdkRoot, "package.json"), "{}");
      await fs.writeFile(path.join(sdkRoot, "dist", "index.js"), "export {};\n");
      await fs.writeFile(path.join(sdkRoot, "native", "libFoundationModels.dylib"), "");
      await fs.writeFile(path.join(koffiRoot, "index.js"), "module.exports = {};\n");
      await fs.writeFile(path.join(koffiRoot, "package.json"), '{"version":"test"}');
      await fs.writeFile(nativeKoffiPath, "");

      await fs.mkdir(
        path.join(dest, "node_modules", "koffi", "build", "koffi", FOUNDATION_MODELS_KOFFI_TRIPLET),
        { recursive: true },
      );
      await fs.mkdir(path.join(dest, "dist"), { recursive: true });
      await fs.mkdir(path.join(dest, "native"), { recursive: true });
      await fs.writeFile(path.join(dest, "dist", "index.js"), "");
      await fs.writeFile(path.join(dest, "native", "libFoundationModels.dylib"), "");
      await fs.writeFile(
        path.join(
          dest,
          "node_modules",
          "koffi",
          "build",
          "koffi",
          FOUNDATION_MODELS_KOFFI_TRIPLET,
          "koffi.node",
        ),
        "",
      );
      await fs.writeFile(path.join(dest, "stale.txt"), "stale");

      await __internal.syncFoundationModelsSdk({
        root,
        dest,
        previousFingerprint: "same",
        nextFingerprint: "same",
        platform: "darwin",
        arch: "arm64",
      });

      await expect(
        fs.stat(path.join(dest, "node_modules", "koffi", "index.js")),
      ).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(dest, "node_modules", "koffi", "package.json")),
      ).resolves.toBeDefined();
      await expect(fs.stat(path.join(dest, "stale.txt"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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

  test("prunes stale sourcemaps, tsbuildinfo files, and .DS_Store from desktop binaries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
    const binariesDir = path.join(root, "apps", "desktop", "resources", "binaries");

    try {
      await fs.mkdir(path.join(binariesDir, "nested"), { recursive: true });
      await fs.writeFile(path.join(binariesDir, "cowork-server-aarch64-apple-darwin"), "binary");
      await fs.writeFile(path.join(binariesDir, "index.js.map"), "sourcemap");
      await fs.writeFile(path.join(binariesDir, "index.js.map.json"), "sourcemap-json");
      await fs.writeFile(path.join(binariesDir, "tsconfig.tsbuildinfo"), "buildinfo");
      await fs.writeFile(path.join(binariesDir, ".DS_Store"), "junk");
      await fs.writeFile(path.join(binariesDir, "nested", "inner.map"), "nested sourcemap");
      await fs.writeFile(path.join(binariesDir, "nested", "keep.txt"), "keep me");

      await __internal.pruneStaleDesktopBinaryArtifacts(binariesDir);

      await expect(
        fs.stat(path.join(binariesDir, "cowork-server-aarch64-apple-darwin")),
      ).resolves.toBeDefined();
      await expect(fs.stat(path.join(binariesDir, "index.js.map"))).rejects.toThrow();
      await expect(fs.stat(path.join(binariesDir, "index.js.map.json"))).rejects.toThrow();
      await expect(fs.stat(path.join(binariesDir, "tsconfig.tsbuildinfo"))).rejects.toThrow();
      await expect(fs.stat(path.join(binariesDir, ".DS_Store"))).rejects.toThrow();
      await expect(fs.stat(path.join(binariesDir, "nested", "inner.map"))).rejects.toThrow();
      await expect(fs.stat(path.join(binariesDir, "nested", "keep.txt"))).resolves.toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("prune is a no-op when the desktop binaries directory does not exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-resources-"));
    try {
      await expect(
        __internal.pruneStaleDesktopBinaryArtifacts(
          path.join(root, "apps", "desktop", "resources", "binaries"),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
