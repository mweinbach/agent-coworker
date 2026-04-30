import { describe, expect, test } from "bun:test";

import {
  isLinux,
  isMacos,
  isWindows,
  normalizePlatform,
} from "../src/lib/desktopPlatform";

describe("normalizePlatform", () => {
  test("maps darwin to macos", () => {
    expect(normalizePlatform("darwin")).toBe("macos");
  });

  test("maps win32 to windows", () => {
    expect(normalizePlatform("win32")).toBe("windows");
  });

  test("maps linux to linux", () => {
    expect(normalizePlatform("linux")).toBe("linux");
  });

  test("maps unknown to other", () => {
    expect(normalizePlatform("freebsd")).toBe("other");
    expect(normalizePlatform(undefined)).toBe("other");
  });
});

describe("platform booleans", () => {
  test("isMacos only returns true for macos", () => {
    expect(isMacos({ platform: "macos" } as never)).toBe(true);
    expect(isMacos({ platform: "windows" } as never)).toBe(false);
  });

  test("isWindows only returns true for windows", () => {
    expect(isWindows({ platform: "windows" } as never)).toBe(true);
    expect(isWindows({ platform: "macos" } as never)).toBe(false);
  });

  test("isLinux only returns true for linux", () => {
    expect(isLinux({ platform: "linux" } as never)).toBe(true);
    expect(isLinux({ platform: "other" } as never)).toBe(false);
  });
});
