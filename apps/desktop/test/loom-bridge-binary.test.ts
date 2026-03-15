import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  buildLoomBridgeManifest,
  findPackagedLoomBridgeBinary,
  resolvePackagedLoomBridgeFilename,
  LOOM_BRIDGE_MANIFEST_NAME,
} from "../electron/services/loomBridgeBinary";

describe("desktop loom bridge packaging helpers", () => {
  test("resolves the packaged filename for darwin arm64", () => {
    expect(resolvePackagedLoomBridgeFilename("darwin", "arm64")).toBe("cowork-loom-bridge-aarch64-apple-darwin");
  });

  test("builds a manifest for the current packaged loom bridge binary", () => {
    expect(buildLoomBridgeManifest("win32", "x64")).toEqual({
      filename: "cowork-loom-bridge-x86_64-pc-windows-msvc.exe",
      targetTriple: "x86_64-pc-windows-msvc",
      platform: "win32",
      arch: "x64",
    });
  });

  test("findPackagedLoomBridgeBinary follows the packaged manifest", () => {
    const dir = path.join(path.sep, "bundle", "Resources", "binaries");
    const manifestPath = path.join(dir, LOOM_BRIDGE_MANIFEST_NAME);
    const manifest = {
      filename: "cowork-loom-bridge-aarch64-apple-darwin",
      targetTriple: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
    };
    const binaryPath = path.join(dir, manifest.filename);

    const binary = findPackagedLoomBridgeBinary([dir], {
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

  test("findPackagedLoomBridgeBinary reports stale helper candidates clearly", () => {
    const dir = path.join(path.sep, "bundle", "Resources", "binaries");

    expect(() =>
      findPackagedLoomBridgeBinary([dir], {
        platform: "darwin",
        arch: "arm64",
        existsSync: (candidate) => candidate === dir,
        readFileSync: () => {
          throw new Error("unexpected read");
        },
        readdirSync: () => [
          "cowork-loom-bridge-x86_64-apple-darwin",
          "cowork-loom-bridge-x86_64-pc-windows-msvc.exe",
        ],
      }),
    ).toThrow(/Expected cowork-loom-bridge-aarch64-apple-darwin/);
  });
});
