import { describe, expect, test } from "bun:test";

import {
  asArray,
  asFiniteNumber,
  asNonEmptyString,
  asNonEmptyStringArray,
  asRecord,
  asString,
} from "../../src/shared/recordParsing";

describe("recordParsing", () => {
  test("asRecord accepts plain objects and rejects null, arrays, and primitives", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toBeNull();
    expect(asRecord([])).toBeNull();
    expect(asRecord("x")).toBeNull();
  });

  test("asString and asNonEmptyString fail closed on blanks and non-strings", () => {
    expect(asString(" hi ")).toBe(" hi ");
    expect(asString(1)).toBeUndefined();
    expect(asNonEmptyString(" hi ")).toBe("hi");
    expect(asNonEmptyString("   ")).toBeUndefined();
    expect(asNonEmptyString(1)).toBeUndefined();
  });

  test("asFiniteNumber accepts only finite numbers", () => {
    expect(asFiniteNumber(0)).toBe(0);
    expect(asFiniteNumber(1.5)).toBe(1.5);
    expect(asFiniteNumber(Number.NaN)).toBeUndefined();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asFiniteNumber("1")).toBeUndefined();
  });

  test("asNonEmptyStringArray trims entries and drops empty results", () => {
    expect(asNonEmptyStringArray(["a", "", " b "])).toEqual(["a", "b"]);
    expect(asNonEmptyStringArray([" ", ""])).toBeUndefined();
    expect(asNonEmptyStringArray("a")).toBeUndefined();
  });

  test("asArray returns the array or an empty fallback", () => {
    expect(asArray([1])).toEqual([1]);
    expect(asArray(null)).toEqual([]);
    expect(asArray({ length: 1 })).toEqual([]);
  });
});
