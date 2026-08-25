import { describe, expect, test } from "bun:test";

import {
  asArray,
  asFiniteNumber,
  asNonEmptyString,
  asNonEmptyStringArray,
  asRecord,
  asString,
} from "../src/shared/recordParsing";

describe("recordParsing fail-closed helpers", () => {
  test("asRecord accepts plain objects and rejects arrays, null, and primitives", () => {
    expect(asRecord({ id: "gpt-5.4" })).toEqual({ id: "gpt-5.4" });
    expect(asRecord([])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord("object")).toBeNull();
  });

  test("asString and asNonEmptyString trim and reject blank values", () => {
    expect(asString(" gpt-5.4 ")).toBe(" gpt-5.4 ");
    expect(asString(1)).toBeUndefined();
    expect(asNonEmptyString(" gpt-5.4 ")).toBe("gpt-5.4");
    expect(asNonEmptyString("   ")).toBeUndefined();
    expect(asNonEmptyString(0)).toBeUndefined();
  });

  test("asFiniteNumber rejects NaN, Infinity, and numeric strings", () => {
    expect(asFiniteNumber(128000)).toBe(128000);
    expect(asFiniteNumber(0)).toBe(0);
    expect(asFiniteNumber(Number.NaN)).toBeUndefined();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asFiniteNumber("128000")).toBeUndefined();
  });

  test("asNonEmptyStringArray drops blanks and treats non-arrays as missing", () => {
    expect(asNonEmptyStringArray([" generateContent ", "", "  ", "countTokens"])).toEqual([
      "generateContent",
      "countTokens",
    ]);
    expect(asNonEmptyStringArray(["", "  "])).toBeUndefined();
    expect(asNonEmptyStringArray("generateContent")).toBeUndefined();
  });

  test("asArray returns the original array and empty for everything else", () => {
    const models = [{ id: "gpt-5.4" }];
    expect(asArray(models)).toBe(models);
    expect(asArray({ data: models })).toEqual([]);
    expect(asArray(null)).toEqual([]);
  });
});
