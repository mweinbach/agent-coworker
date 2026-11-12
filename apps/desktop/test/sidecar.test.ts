import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildSidecarManifest,
  findPackagedSidecarLaunchCommand,
  resolveDesktopTargetTriple,
  resolvePackagedSidecarFilename,
  SIDECAR_MANIFEST_NAME,
} from "../electron/services/sidecar";

describe("desktop sidecar packaging helpers", () => {
  test("resolves the packaged filename for darwin arm64", () => {
    expect(resolveDesktopTargetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(resolvePackagedSidecarFilename("darwin", "arm64")).toBe(
      "cowork-server-aarch64-apple-darwin",
    );
  });

  test("builds an executable manifest for supported compiled targets", () => {
    expect(buildSidecarManifest("win32", "x64")).toEqual({
      targetTriple: "x86_64-pc-windows-msvc",
      platform: "win32",
      arch: "x64",
      launch: {
        kind: "executable",
        path: "cowork-server-x86_64-pc-windows-msvc.exe",
      },
    });
  });

  test("builds a native executable manifest for Windows ARM64", () => {
    expect(buildSidecarManifest("win32", "arm64")).toEqual({
      targetTriple: "aarch64-pc-windows-msvc",
      platform: "win32",
      arch: "arm64",
      launch: {
        kind: "executable",
        path: "cowork-server-aarch64-pc-windows-msvc.exe",
      },
    });
  });

  test("findPackagedSidecarLaunchCommand prefers the explicit override path", () => {
    const explicit = "/tmp/custom-cowork-server";
    const launch = findPackagedSidecarLaunchCommand(["/missing"], {
      explicitPath: explicit,
      existsSync: (candidate) => candidate === explicit,
      readFileSync: () => {
        throw new Error("unexpected read");
      },
      readdirSync: () => [],
      lstatSync: () =>
        ({ isDirectory: () => false }) as ReturnType<typeof import("node:fs").lstatSync>,
    });

    expect(launch.command).toBe(explicit);
    expect(launch.args).toEqual([]);
  });

  test("findPackagedSidecarLaunchCommand follows the packaged executable manifest", () => {
    const dir = path.join(path.sep, "bundle", "Resources", "binaries");
    const manifestPath = path.join(dir, SIDECAR_MANIFEST_NAME);
    const manifest = {
      targetTriple: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
      launch: {
        kind: "executable",
        path: "cowork-server-aarch64-apple-darwin",
      },
    };
    const binaryPath = path.join(dir, "cowork-server-aarch64-apple-darwin");

    const launch = findPackagedSidecarLaunchCommand([dir], {
      platform: "darwin",
      arch: "arm64",
      existsSync: (candidate) =>
        candidate === dir || candidate === manifestPath || candidate === binaryPath,
      readFileSync: (candidate) => {
        if (candidate === manifestPath) {
          return JSON.stringify(manifest);
        }
        throw new Error(`unexpected read: ${candidate}`);
      },
      readdirSync: () => [],
      lstatSync: () =>
        ({ isDirectory: () => true }) as ReturnType<typeof import("node:fs").lstatSync>,
    });

    expect(launch).toEqual({
      command: binaryPath,
      args: [],
      targetTriple: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
      manifestPath,
    });
  });

  test("findPackagedSidecarLaunchCommand launches the native Windows ARM64 executable", () => {
    const dir = path.join(path.sep, "bundle", "Resources", "binaries");
    const manifestPath = path.join(dir, SIDECAR_MANIFEST_NAME);
    const binaryPath = path.join(dir, "cowork-server-aarch64-pc-windows-msvc.exe");
    const manifest = buildSidecarManifest("win32", "arm64");

    const launch = findPackagedSidecarLaunchCommand([dir], {
      platform: "win32",
      arch: "arm64",
      existsSync: (candidate) =>
        candidate === dir || candidate === manifestPath || candidate === binaryPath,
      readFileSync: (candidate) => {
        if (candidate === manifestPath) {
          return JSON.stringify(manifest);
        }
        throw new Error(`unexpected read: ${candidate}`);
      },
      readdirSync: () => [],
      lstatSync: () =>
        ({ isDirectory: () => true }) as ReturnType<typeof import("node:fs").lstatSync>,
    });

    expect(launch).toEqual({
      command: binaryPath,
      args: [],
      targetTriple: "aarch64-pc-windows-msvc",
      platform: "win32",
      arch: "arm64",
      manifestPath,
    });
  });

  test.each([
    {
      name: "Bun launch spec",
      shape: {
        launch: {
          kind: "bun",
          runtime: "bun.exe",
          entrypoint: "server/index.js",
          args: ["--legacy"],
        },
      },
    },
    { name: "filename-only", shape: { filename: "cowork-server.exe" } },
  ])("findPackagedSidecarLaunchCommand rejects legacy $name sidecar manifests", ({ shape }) => {
    const dir = path.join(path.sep, "bundle", "Resources", "binaries");
    const manifestPath = path.join(dir, SIDECAR_MANIFEST_NAME);
    const manifest = {
      targetTriple: "aarch64-pc-windows-msvc",
      platform: "win32",
      arch: "arm64",
      ...shape,
    };

    expect(() =>
      findPackagedSidecarLaunchCommand([dir], {
        platform: "win32",
        arch: "arm64",
        existsSync: (candidate) => candidate === dir || candidate === manifestPath,
        readFileSync: (candidate) => {
          if (candidate === manifestPath) {
            return JSON.stringify(manifest);
          }
          throw new Error(`unexpected read: ${candidate}`);
        },
        readdirSync: () => [],
        lstatSync: () =>
          ({ isDirectory: () => true }) as ReturnType<typeof import("node:fs").lstatSync>,
      }),
    ).toThrow(`Bundled sidecar manifest is invalid: ${manifestPath}`);
  });

  test.each([
    { platform: "win32", arch: "x64", targetTriple: "x86_64-pc-windows-msvc" },
    { platform: "darwin", arch: "arm64", targetTriple: "aarch64-apple-darwin" },
    { platform: "win32", arch: "arm64", targetTriple: "x86_64-pc-windows-msvc" },
  ])("rejects sidecar manifests incompatible with the native Windows ARM64 host: %j", (target) => {
    const dir = path.join(path.sep, "bundle", "Resources", "binaries");
    const launch = { kind: "executable", path: "cowork-server.exe" };
    expect(() =>
      findPackagedSidecarLaunchCommand([dir], {
        platform: "win32",
        arch: "arm64",
        existsSync: () => true,
        readFileSync: () => JSON.stringify({ ...target, launch }),
        readdirSync: () => [],
      }),
    ).toThrow("this host requires win32/arm64 (aarch64-pc-windows-msvc)");
  });

  test("findPackagedSidecarLaunchCommand falls back to the expected exact filename", () => {
    const dir = path.join(path.sep, "bundle", "Resources", "binaries");
    const binaryPath = path.join(dir, "cowork-server-aarch64-apple-darwin");

    const launch = findPackagedSidecarLaunchCommand([dir], {
      platform: "darwin",
      arch: "arm64",
      existsSync: (candidate) => candidate === dir || candidate === binaryPath,
      readFileSync: () => {
        throw new Error("unexpected read");
      },
      readdirSync: () => [],
      lstatSync: () =>
        ({ isDirectory: () => true }) as ReturnType<typeof import("node:fs").lstatSync>,
    });

    expect(launch.command).toBe(binaryPath);
    expect(launch.args).toEqual([]);
  });

  test("findPackagedSidecarLaunchCommand reports stale sidecar candidates clearly", () => {
    const dir = path.join(path.sep, "bundle", "Resources", "binaries");

    expect(() =>
      findPackagedSidecarLaunchCommand([dir], {
        platform: "darwin",
        arch: "arm64",
        existsSync: (candidate) => candidate === dir,
        readFileSync: () => {
          throw new Error("unexpected read");
        },
        readdirSync: () => [
          "cowork-server-x86_64-pc-windows-msvc.exe",
          "cowork-server-x86_64-apple-darwin",
        ],
        lstatSync: () =>
          ({ isDirectory: () => true }) as ReturnType<typeof import("node:fs").lstatSync>,
      }),
    ).toThrow(/Expected cowork-server-aarch64-apple-darwin/);
  });
});
