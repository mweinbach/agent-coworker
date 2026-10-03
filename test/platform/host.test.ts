import { describe, expect, test } from "bun:test";

import { toDesktopPlatform } from "../../src/platform/host";

describe("toDesktopPlatform", () => {
  test("maps Node platforms onto the desktop vocabulary and fails closed for unknown hosts", () => {
    expect(toDesktopPlatform("win32")).toBe("windows");
    expect(toDesktopPlatform("darwin")).toBe("macos");
    expect(toDesktopPlatform("linux")).toBe("linux");
    expect(toDesktopPlatform("freebsd")).toBe("other");
    expect(toDesktopPlatform("android")).toBe("other");
  });
});
