import { describe, expect, test } from "bun:test";

import {
  formatString,
  getByPointer,
  resolveDynamic,
  resolveDynamicBoolean,
  resolveDynamicNumber,
  resolveDynamicString,
  setByPointer,
  splitPointer,
} from "../../src/shared/a2ui/expressions";

describe("splitPointer", () => {
  test("splits plain pointers", () => {
    expect(splitPointer("/a/b/c")).toEqual(["a", "b", "c"]);
    expect(splitPointer("")).toEqual([]);
    expect(splitPointer("/")).toEqual([]);
  });
  test("decodes ~0 and ~1", () => {
    expect(splitPointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
  });
  test("allows leading-slash-less input for convenience", () => {
    expect(splitPointer("user/name")).toEqual(["user", "name"]);
  });
});

describe("getByPointer", () => {
  const model = { user: { name: "Ada", tags: ["a", "b"] }, nested: null };
  test("returns scalar values", () => {
    expect(getByPointer(model, ["user", "name"])).toBe("Ada");
  });
  test("indexes into arrays", () => {
    expect(getByPointer(model, ["user", "tags", "1"])).toBe("b");
  });
  test("returns undefined for missing paths", () => {
    expect(getByPointer(model, ["user", "missing"])).toBeUndefined();
  });
  test("handles null/undefined bridges safely", () => {
    expect(getByPointer(model, ["nested", "x"])).toBeUndefined();
  });
});

describe("setByPointer", () => {
  test("sets scalar values without mutating original", () => {
    const model = { a: 1 };
    const next = setByPointer(model, ["b"], 2) as { a: number; b: number };
    expect(next).toEqual({ a: 1, b: 2 });
    expect(model).toEqual({ a: 1 });
  });
  test("creates intermediate objects", () => {
    const next = setByPointer({}, ["a", "b", "c"], 7) as Record<string, unknown>;
    expect(next).toEqual({ a: { b: { c: 7 } } });
  });
  test("inserts into arrays", () => {
    const next = setByPointer([1, 2, 3], ["1"], 99) as number[];
    expect(next).toEqual([1, 99, 3]);
  });
  test("deletes object keys", () => {
    const next = setByPointer({ a: 1, b: 2 }, ["a"], null, true) as Record<string, unknown>;
    expect(next).toEqual({ b: 2 });
  });
  test("deletes array entries", () => {
    const next = setByPointer([1, 2, 3], ["1"], null, true) as number[];
    expect(next).toEqual([1, 3]);
  });
  test("returns full replacement when tokens is empty", () => {
    expect(setByPointer({ a: 1 }, [], { b: 2 })).toEqual({ b: 2 });
  });
});

describe("resolveDynamic", () => {
  const model = { name: "Ada", active: true, count: 2 };

  test("returns primitives unchanged", () => {
    expect(resolveDynamic("hi", model)).toBe("hi");
    expect(resolveDynamic(42, model)).toBe(42);
    expect(resolveDynamic(true, model)).toBe(true);
  });

  test("resolves { path }", () => {
    expect(resolveDynamic({ path: "/name" }, model)).toBe("Ada");
  });

  test("resolves { $ref }", () => {
    expect(resolveDynamic({ $ref: "/count" }, model)).toBe(2);
  });

  test("resolves { literal }", () => {
    expect(resolveDynamic({ literal: [1, 2] }, model)).toEqual([1, 2]);
  });

  test("resolves { formatString }", () => {
    expect(resolveDynamic({ formatString: "Hello ${/name}, count=${/count}" }, model)).toBe(
      "Hello Ada, count=2",
    );
  });

  test("coerces booleans and numbers safely", () => {
    expect(resolveDynamicBoolean({ path: "/active" }, model)).toBe(true);
    expect(resolveDynamicNumber({ path: "/count" }, model)).toBe(2);
    expect(resolveDynamicNumber({ path: "/missing" }, model)).toBe(null);
  });

  test("stringifies unknown values gracefully", () => {
    expect(resolveDynamicString({ path: "/missing" }, model)).toBe("");
    expect(resolveDynamicString({ path: "/" }, model)).toContain("Ada");
  });
});

describe("formatString", () => {
  test("replaces unknown tokens with empty string", () => {
    expect(formatString("a=${/missing};", { x: 1 })).toBe("a=;");
  });
  test("does not allow raw JS expressions", () => {
    // ${1+1} is not a JSON pointer — should render empty.
    expect(formatString("x=${1+1}", {})).toBe("x=");
  });
});
