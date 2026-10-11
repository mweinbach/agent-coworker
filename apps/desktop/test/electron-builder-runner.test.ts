import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRoots } from "../../../src/platform/sandbox/policy";
import {
  resolveNativeElectronDist,
  resolveWindowsSigningConfig,
} from "../scripts/runElectronBuilder";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
let electronRoot: string;
let x64Dist: string;
let arm64Dist: string;

beforeAll(() => {
  electronRoot = mkdtempSync(path.join(scratchRoots()[0], "cowork-electron-dist-"));
  x64Dist = path.join(electronRoot, "x64", "node_modules", "electron", "dist");
  arm64Dist = path.join(electronRoot, "arm64", "node_modules", "electron", "dist");
  for (const [dist, machine] of [
    [x64Dist, 0x8664],
    [arm64Dist, 0xaa64],
  ] as const) {
    const pe = Buffer.alloc(128);
    pe.writeUInt16LE(0x5a4d, 0);
    pe.writeUInt32LE(0x40, 0x3c);
    pe.writeUInt32LE(0x00004550, 0x40);
    pe.writeUInt16LE(machine, 0x44);
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "electron.exe"), pe);
  }
});

afterAll(() => rmSync(electronRoot, { recursive: true, force: true }));

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
    const result = resolveNativeElectronDist([], {}, { platform: "win32", arch: "x64" }, x64Dist);

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

  test("does not force one installed distribution into multiple architecture targets", () => {
    expect(
      resolveNativeElectronDist(["--x64", "--arm64"], {}, { platform: "win32", arch: "x64" }),
    ).toBeUndefined();
  });

  test("does not force one installed distribution into multiple platform targets", () => {
    expect(
      resolveNativeElectronDist(["--mac", "--win"], {}, { platform: "darwin", arch: "arm64" }),
    ).toBeUndefined();
  });

  test("uses the installed distribution on native ARM64 hosts", () => {
    const result = resolveNativeElectronDist(
      ["--arm64"],
      { COWORK_BUILD_PLATFORM: "win32", COWORK_BUILD_ARCH: "arm64" },
      { platform: "win32", arch: "arm64" },
      arm64Dist,
    );

    expect(result).toEndWith(path.join("node_modules", "electron", "dist"));
  });

  test("downloads native Electron instead of reusing a stale x64 distribution on ARM64", () => {
    expect(
      resolveNativeElectronDist(["--arm64"], {}, { platform: "win32", arch: "arm64" }, x64Dist),
    ).toBeUndefined();
    expect(
      resolveNativeElectronDist(
        ["--arm64"],
        {},
        { platform: "win32", arch: "arm64" },
        path.join(electronRoot, "missing"),
      ),
    ).toBeUndefined();
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

  test("disables updater signature verification for unsigned Windows builds", () => {
    expect(resolveWindowsSigningConfig(["--win"], {}, { platform: "win32", arch: "x64" })).toEqual([
      "--config.win.verifyUpdateCodeSignature=false",
    ]);
    expect(
      resolveWindowsSigningConfig(
        ["--win"],
        { CSC_LINK: "cert.p12", CSC_KEY_PASSWORD: "secret" },
        { platform: "win32", arch: "x64" },
      ),
    ).toEqual([]);
    expect(
      resolveWindowsSigningConfig(["--mac"], {}, { platform: "darwin", arch: "arm64" }),
    ).toEqual([]);
  });

  test("configures unsigned Windows updates when Windows is one of several targets", () => {
    expect(
      resolveWindowsSigningConfig(["--mac", "--win"], {}, { platform: "darwin", arch: "arm64" }),
    ).toEqual(["--config.win.verifyUpdateCodeSignature=false"]);
  });
});
