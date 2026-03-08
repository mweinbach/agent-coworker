import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildSidecarManifest,
  findPackagedSidecarBinary,
  resolveDesktopTargetTriple,
  resolvePackagedSidecarFilename,
  SIDECAR_MANIFEST_NAME,
} from "../electron/services/sidecar";

describe("desktop sidecar packaging helpers", () => {
  test("resolves the packaged filename for darwin arm64", () => {
    expect(resolveDesktopTargetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(resolvePackagedSidecarFilename("darwin", "arm64")).toBe("cowork-server-aarch64-apple-darwin");
  });

  test("builds a manifest for the current packaged binary", () => {
    expect(buildSidecarManifest("win32", "x64")).toEqual({
      filename: "cowork-server-x86_64-pc-windows-msvc.exe",
      targetTriple: "x86_64-pc-windows-msvc",
      platform: "win32",
      arch: "x64",
    });
  });

  test("findPackagedSidecarBinary prefers the explicit override path", () => {
    const explicit = "/tmp/custom-cowork-server";
    const binary = findPackagedSidecarBinary(["/missing"], {
      explicitPath: explicit,
      existsSync: (candidate) => candidate === explicit,
      readFileSync: () => {
        throw new Error("unexpected read");
      },
      readdirSync: () => [],
    });

    expect(binary).toBe(explicit);
  });

  test("findPackagedSidecarBinary follows the packaged manifest", () => {
    const dir = path.join(path.sep, "bundle", "Resources", "binaries");
    const manifestPath = path.join(dir, SIDECAR_MANIFEST_NAME);
    const manifest = {
      filename: "cowork-server-aarch64-apple-darwin",
      targetTriple: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
    };
    const binaryPath = path.join(dir, manifest.filename);

    const binary = findPackagedSidecarBinary([dir], {
      platform: "darwin",
      arch: "arm64",
      existsSync: (candidate) => candidate === dir || candidate === manifestPath || candidate === binaryPath,
      readFileSync: (candidate) => {
        if (candidate === manifestPath) {
          return JSON.stringify(manifest);
        }
        throw new Error(`unexpected read: ${candidate}`);
      },
      readdirSync: () => [],
    });

    expect(binary).toBe(binaryPath);
  });

  test("findPackagedSidecarBinary falls back to the expected exact filename", () => {
    const dir = path.join(path.sep, "bundle", "Resources", "binaries");
    const binaryPath = path.join(dir, "cowork-server-aarch64-apple-darwin");

    const binary = findPackagedSidecarBinary([dir], {
      platform: "darwin",
      arch: "arm64",
      existsSync: (candidate) => candidate === dir || candidate === binaryPath,
      readFileSync: () => {
        throw new Error("unexpected read");
      },
      readdirSync: () => [],
    });

    expect(binary).toBe(binaryPath);
  });

  test("findPackagedSidecarBinary reports stale sidecar candidates clearly", () => {
    const dir = path.join(path.sep, "bundle", "Resources", "binaries");

    expect(() =>
      findPackagedSidecarBinary([dir], {
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
      })
    ).toThrow(/Expected cowork-server-aarch64-apple-darwin/);
  });
});
