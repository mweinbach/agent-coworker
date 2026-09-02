import { describe, expect, test } from "bun:test";
import type fs from "node:fs/promises";

import { resolveBuildTarget, resolveBunCompileTarget, rmrf } from "../scripts/releaseBuildUtils";

describe("release build utils", () => {
  describe("resolveBunCompileTarget", () => {
    test.each([
      { platform: "darwin", arch: "x64", target: "bun-darwin-x64" },
      { platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" },
      { platform: "win32", arch: "x64", target: "bun-windows-x64" },
      { platform: "win32", arch: "arm64", target: "bun-windows-arm64" },
      { platform: "linux", arch: "x64", target: "bun-linux-x64" },
      { platform: "linux", arch: "arm64", target: "bun-linux-arm64" },
    ] as const)("maps $platform/$arch to $target", ({ platform, arch, target }) => {
      expect(resolveBunCompileTarget(platform, arch)).toBe(target);
    });

    test("rejects unsupported target platforms with an actionable error", () => {
      expect(() => resolveBunCompileTarget("freebsd", "x64")).toThrow(
        "Unsupported Bun executable target platform: freebsd; supported platforms are darwin, win32, and linux",
      );
    });

    test.each(["ia32", "arm", "aarch64", "amd64", ""])(
      "rejects unsupported or noncanonical target architecture '%s'",
      (arch) => {
        expect(() => resolveBunCompileTarget("linux", arch)).toThrow(
          `Unsupported Bun executable target architecture: ${arch}; supported architectures are x64 and arm64`,
        );
      },
    );

    test("compiles normalized Windows ARM64 CLI aliases as native executables", () => {
      const target = resolveBuildTarget(
        ["--target-platform", "windows", "--target-arch", "aarch64"],
        {},
      );

      expect(target).toEqual({ platform: "win32", arch: "arm64" });
      expect(resolveBunCompileTarget(target.platform, target.arch)).toBe("bun-windows-arm64");
    });
  });

  test("rmrf enables bounded retries for transient Windows file locks", async () => {
    const calls: Array<{
      target: string;
      options: Parameters<typeof fs.rm>[1];
    }> = [];
    const target = "C:\\workspace\\apps\\desktop\\resources\\binaries";

    await rmrf(target, {
      rmImpl: async (receivedTarget, options) => {
        calls.push({ target: receivedTarget, options });
      },
    });

    expect(calls).toEqual([
      {
        target,
        options: {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        },
      },
    ]);
  });
});
