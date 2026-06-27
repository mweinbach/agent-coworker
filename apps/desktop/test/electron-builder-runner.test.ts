import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeElectronDist } from "../scripts/runElectronBuilder";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));

describe("Electron builder native distribution selection", () => {
  test("keeps the packaging pin aligned with the installed Electron dependency", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
    ) as { devDependencies: { electron: string } };
    const configuredVersion = packageJson.devDependencies.electron.match(/\d+\.\d+\.\d+/)?.[0];
    const builderConfig = readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf8");

    expect(configuredVersion).toBeDefined();
    expect(builderConfig).toContain(`electronVersion: ${configuredVersion}`);
  });

  test("uses the installed Electron distribution for native builds", () => {
    const result = resolveNativeElectronDist([], {}, { platform: "win32", arch: "x64" });

    expect(result).toEndWith(path.join("node_modules", "electron", "dist"));
  });

  test("keeps target downloads for cross-architecture release builds", () => {
    const result = resolveNativeElectronDist(
      ["--arm64"],
      { COWORK_BUILD_PLATFORM: "win32", COWORK_BUILD_ARCH: "arm64" },
      { platform: "win32", arch: "x64" },
    );

    expect(result).toBeUndefined();
  });

  test("uses the installed distribution on native ARM64 hosts", () => {
    const result = resolveNativeElectronDist(
      ["--arm64"],
      { COWORK_BUILD_PLATFORM: "win32", COWORK_BUILD_ARCH: "arm64" },
      { platform: "win32", arch: "arm64" },
    );

    expect(result).toEndWith(path.join("node_modules", "electron", "dist"));
  });

  test("does not override cross-platform builds or an explicit distribution", () => {
    expect(
      resolveNativeElectronDist(["--mac"], {}, { platform: "win32", arch: "x64" }),
    ).toBeUndefined();
    expect(
      resolveNativeElectronDist(
        ["--config.electronDist=C:/electron"],
        {},
        {
          platform: "win32",
          arch: "x64",
        },
      ),
    ).toBeUndefined();
  });
});
