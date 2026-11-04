import { describe, expect, test } from "bun:test";
import type fs from "node:fs/promises";

import { resolveBuildTarget, resolveRustCompileTarget, rmrf } from "../scripts/releaseBuildUtils";

describe("release build utils", () => {
  describe("resolveRustCompileTarget", () => {
    test.each([
      { platform: "darwin", arch: "x64", target: "x86_64-apple-darwin" },
      { platform: "darwin", arch: "arm64", target: "aarch64-apple-darwin" },
      { platform: "win32", arch: "x64", target: "x86_64-pc-windows-msvc" },
      { platform: "win32", arch: "arm64", target: "aarch64-pc-windows-msvc" },
      { platform: "linux", arch: "x64", target: "x86_64-unknown-linux-gnu" },
      { platform: "linux", arch: "arm64", target: "aarch64-unknown-linux-gnu" },
    ] as const)("maps $platform/$arch to $target", ({ platform, arch, target }) => {
      expect(resolveRustCompileTarget(platform, arch)).toBe(target);
    });

    test("rejects unsupported target platforms with an actionable error", () => {
      expect(() => resolveRustCompileTarget("freebsd", "x64")).toThrow(
        "Unsupported Rust executable target platform: freebsd; supported platforms are darwin, win32, and linux",
      );
    });

    test.each(["ia32", "arm", "aarch64", "amd64", ""])(
      "rejects unsupported or noncanonical target architecture '%s'",
      (arch) => {
        expect(() => resolveRustCompileTarget("linux", arch)).toThrow(
          `Unsupported Rust executable target architecture: ${arch}; supported architectures are x64 and arm64`,
        );
      },
    );

    test("compiles normalized Windows ARM64 CLI aliases as native Rust executables", () => {
      const target = resolveBuildTarget(
        ["--target-platform", "windows", "--target-arch", "aarch64"],
        {},
      );

      expect(target).toEqual({ platform: "win32", arch: "arm64" });
      expect(resolveRustCompileTarget(target.platform, target.arch)).toBe(
        "aarch64-pc-windows-msvc",
      );
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
