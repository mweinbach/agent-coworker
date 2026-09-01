import { describe, expect, test } from "bun:test";

import { fileChangeVersionsEqual } from "../../src/shared/fileVersion";

const version = {
  modifiedAtMs: 10,
  changeTimeMs: 11,
  size: 4,
  fingerprint: "abc",
};

describe("fileChangeVersionsEqual", () => {
  test("treats matching versions as equal and any field mismatch as different", () => {
    expect(fileChangeVersionsEqual(version, { ...version })).toBe(true);
    expect(fileChangeVersionsEqual(version, { ...version, modifiedAtMs: 9 })).toBe(false);
    expect(fileChangeVersionsEqual(version, { ...version, changeTimeMs: 9 })).toBe(false);
    expect(fileChangeVersionsEqual(version, { ...version, size: 5 })).toBe(false);
    expect(fileChangeVersionsEqual(version, { ...version, fingerprint: "xyz" })).toBe(false);
  });

  test("only treats nullish pairs as equal when both sides are the same absence", () => {
    expect(fileChangeVersionsEqual(null, null)).toBe(true);
    expect(fileChangeVersionsEqual(undefined, undefined)).toBe(true);
    expect(fileChangeVersionsEqual(null, undefined)).toBe(false);
    expect(fileChangeVersionsEqual(version, null)).toBe(false);
    expect(fileChangeVersionsEqual(undefined, version)).toBe(false);
  });
});
