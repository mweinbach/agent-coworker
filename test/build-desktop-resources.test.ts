import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { __internal } from "../scripts/build_desktop_resources";
import { scratchRoots } from "../src/platform/scratchRoots";
import { resolveStagedBinariesDir } from "../src/platform/sidecar";

describe("desktop resource build helpers", () => {
  test("sidecar fingerprint inputs and staging dir are independent of apps/desktop", () => {
    const root = path.resolve(import.meta.dir, "..");
    const inputs = __internal.resolveSidecarInputs(root);
    expect(inputs.some((entry) => entry.includes(path.join("apps", "desktop")))).toBe(false);
    expect(inputs).toContain(path.join(root, "src", "platform", "sidecar.ts"));
    expect(resolveStagedBinariesDir(root)).toBe(path.join(root, "dist", "binaries"));
  });

  test("invalidates sidecar fingerprints when only the compiler revision changes", async () => {
    const root = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-sidecar-cache-"));
    try {
      const source = path.join(root, "index.ts");
      await fs.writeFile(source, "export const version = 1;");
      const first = await __internal.fingerprintInputs([source], root, "canary:revision-a");
      const next = await __internal.fingerprintInputs([source], root, "canary:revision-b");
      expect(next).not.toBe(first);
      expect(await __internal.fingerprintInputs([source], root, "canary:revision-b")).toBe(next);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("invalidates resource fingerprints for same-length edits with preserved mtimes", async () => {
    const root = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-resource-cache-"));
    try {
      const source = path.join(root, "index.ts");
      const timestamp = new Date("2026-01-01T00:00:00.000Z");
      await fs.writeFile(source, "export const version = 1;");
      await fs.utimes(source, timestamp, timestamp);
      const first = await __internal.fingerprintInputs([source], root);
      await fs.writeFile(source, "export const version = 2;");
      await fs.utimes(source, timestamp, timestamp);
      expect(await __internal.fingerprintInputs([source], root)).not.toBe(first);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("sidecar cleanup preserves independently managed native resources", async () => {
    const root = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-desktop-resources-"));
    const binariesDir = resolveStagedBinariesDir(root);

    try {
      await fs.mkdir(binariesDir, { recursive: true });
      await fs.writeFile(path.join(binariesDir, "cowork-server-manifest.json"), "{}");
      await fs.writeFile(path.join(binariesDir, "cowork-server-x86_64-pc-windows-msvc.exe"), "");
      await fs.writeFile(path.join(binariesDir, "cowork-server-aarch64-apple-darwin"), "");
      await fs.writeFile(path.join(binariesDir, "custom-resource.bin"), "keep");

      await __internal.clearDesktopSidecarArtifacts(binariesDir);

      await expect(
        fs.stat(path.join(binariesDir, "cowork-server-manifest.json")),
      ).rejects.toThrow();
      await expect(
        fs.stat(path.join(binariesDir, "cowork-server-x86_64-pc-windows-msvc.exe")),
      ).rejects.toThrow();
      await expect(
        fs.stat(path.join(binariesDir, "cowork-server-aarch64-apple-darwin")),
      ).rejects.toThrow();
      await expect(
        fs.readFile(path.join(binariesDir, "custom-resource.bin"), "utf8"),
      ).resolves.toBe("keep");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("prunes stale sourcemaps, tsbuildinfo files, and .DS_Store from desktop binaries", async () => {
    const root = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-desktop-resources-"));
    const binariesDir = resolveStagedBinariesDir(root);

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
    const root = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-desktop-resources-"));
    try {
      await expect(
        __internal.pruneStaleDesktopBinaryArtifacts(resolveStagedBinariesDir(root)),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
