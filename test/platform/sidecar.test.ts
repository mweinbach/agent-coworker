import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../src/platform/scratchRoots";
import {
  buildSidecarManifest,
  findPackagedSidecarLaunchCommand,
  isSidecarManifest,
  resolveDesktopTargetTriple,
  resolvePackagedSidecarFilename,
  resolveStagedBinariesDir,
  SIDECAR_MANIFEST_NAME,
} from "../../src/platform/sidecar";

describe("neutral platform sidecar helpers", () => {
  test("resolves neutral staged binaries dir and target triples", () => {
    expect(resolveStagedBinariesDir("/repo")).toBe(path.join("/repo", "dist", "binaries"));
    expect(resolveDesktopTargetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(resolveDesktopTargetTriple("win32", "arm64")).toBe("aarch64-pc-windows-msvc");
    expect(resolveDesktopTargetTriple("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(resolvePackagedSidecarFilename("win32", "x64")).toBe(
      "cowork-server-x86_64-pc-windows-msvc.exe",
    );
  });

  test("builds and validates default and custom-path sidecar manifests", () => {
    const defaultManifest = buildSidecarManifest("darwin", "arm64");
    expect(isSidecarManifest(defaultManifest)).toBe(true);
    expect(defaultManifest).toEqual({
      targetTriple: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
      launch: {
        kind: "executable",
        path: "cowork-server-aarch64-apple-darwin",
      },
    });

    const serverReleaseManifest = buildSidecarManifest("win32", "arm64", "cowork-server.exe");
    expect(isSidecarManifest(serverReleaseManifest)).toBe(true);
    expect(serverReleaseManifest.launch.path).toBe("cowork-server.exe");
    expect(isSidecarManifest({ targetTriple: "x" })).toBe(false);
  });

  test("finds a staged sidecar via manifest in neutral dist/binaries", async () => {
    const root = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "cowork-sidecar-"));
    try {
      const binariesDir = resolveStagedBinariesDir(root);
      await fs.mkdir(binariesDir, { recursive: true });
      const binName = resolvePackagedSidecarFilename("darwin", "arm64");
      const binPath = path.join(binariesDir, binName);
      await fs.writeFile(binPath, "bin");
      await fs.writeFile(
        path.join(binariesDir, SIDECAR_MANIFEST_NAME),
        JSON.stringify(buildSidecarManifest("darwin", "arm64")),
      );

      const found = findPackagedSidecarLaunchCommand([binariesDir], {
        platform: "darwin",
        arch: "arm64",
      });
      expect(found.command).toBe(binPath);
      expect(found.targetTriple).toBe("aarch64-apple-darwin");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
