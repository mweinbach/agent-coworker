import { describe, expect, test } from "bun:test";

import { type FileChangeVersion, fileChangeVersionsEqual } from "../../src/shared/fileVersion";

const version = (overrides: Partial<FileChangeVersion> = {}): FileChangeVersion => ({
  modifiedAtMs: 1_700_000_000_000,
  changeTimeMs: 1_700_000_000_500,
  size: 42,
  fingerprint: "abc",
  ...overrides,
});

describe("fileChangeVersionsEqual", () => {
  test("treats matching versions as equal and mismatches as distinct", () => {
    const left = version();
    expect(fileChangeVersionsEqual(left, version())).toBe(true);
    expect(fileChangeVersionsEqual(left, version({ modifiedAtMs: left.modifiedAtMs + 1 }))).toBe(
      false,
    );
    expect(fileChangeVersionsEqual(left, version({ changeTimeMs: left.changeTimeMs + 1 }))).toBe(
      false,
    );
    expect(fileChangeVersionsEqual(left, version({ size: left.size + 1 }))).toBe(false);
    expect(fileChangeVersionsEqual(left, version({ fingerprint: "def" }))).toBe(false);
  });

  test("treats missing versions as equal only when both sides are the same nullish value", () => {
    expect(fileChangeVersionsEqual(null, null)).toBe(true);
    expect(fileChangeVersionsEqual(undefined, undefined)).toBe(true);
    expect(fileChangeVersionsEqual(null, undefined)).toBe(false);
    expect(fileChangeVersionsEqual(undefined, null)).toBe(false);
    expect(fileChangeVersionsEqual(version(), null)).toBe(false);
    expect(fileChangeVersionsEqual(null, version())).toBe(false);
    expect(fileChangeVersionsEqual(version(), undefined)).toBe(false);
  });
});
