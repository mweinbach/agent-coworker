import { describe, expect, test } from "bun:test";
import { toDesktopPlatform } from "../../src/platform/host";

describe("toDesktopPlatform", () => {
  test("maps Node platforms onto the desktop vocabulary and fails closed for unknown hosts", () => {
    for (const [p, expected] of [
      ["win32", "windows"],
      ["darwin", "macos"],
      ["linux", "linux"],
      ["freebsd", "other"],
      ["android", "other"],
    ] as const) {
      expect(toDesktopPlatform(p)).toBe(expected);
    }
  });
});
