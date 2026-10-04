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
  test("parses records, strings, numbers, and arrays while failing closed on invalid inputs", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    for (const bad of [null, [], "x"]) expect(asRecord(bad)).toBeNull();

    expect(asString(" hi ")).toBe(" hi ");
    expect(asString(1)).toBeUndefined();
    expect(asNonEmptyString(" hi ")).toBe("hi");
    expect(asNonEmptyString("   ")).toBeUndefined();
    expect(asNonEmptyString(1)).toBeUndefined();

    expect(asFiniteNumber(0)).toBe(0);
    expect(asFiniteNumber(1.5)).toBe(1.5);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      expect(asFiniteNumber(bad)).toBeUndefined();
    }

    expect(asNonEmptyStringArray(["a", "", " b "])).toEqual(["a", "b"]);
    expect(asNonEmptyStringArray([" ", ""])).toBeUndefined();
    expect(asNonEmptyStringArray("a")).toBeUndefined();

    expect(asArray([1])).toEqual([1]);
    expect(asArray(null)).toEqual([]);
    expect(asArray({ length: 1 })).toEqual([]);
  });
});
