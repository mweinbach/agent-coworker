import { describe, expect, test } from "bun:test";

import pkg from "../package.json";
import { resolveVersion, VERSION } from "../src/version";

describe("version resolution", () => {
  test("falls back to the packaged version", () => {
    expect(resolveVersion({})).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });

  test("prefers an explicit environment override", () => {
    expect(resolveVersion({ COWORK_VERSION: "1.2.3" })).toBe("1.2.3");
  });

  test("ignores blank environment overrides", () => {
    expect(resolveVersion({ COWORK_VERSION: "   " })).toBe(pkg.version);
  });
});
