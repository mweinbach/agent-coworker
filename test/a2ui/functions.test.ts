import { describe, expect, test } from "bun:test";

import {
  evaluateA2uiFunction,
  isA2uiFunctionCall,
  resolveDynamicWithFunctions,
} from "../../src/shared/a2ui/functions";

describe("isA2uiFunctionCall", () => {
  test("detects a function call object", () => {
    expect(isA2uiFunctionCall({ if: { cond: true, then: "yes" } })).toBe(true);
    expect(isA2uiFunctionCall({ length: { path: "/items" } })).toBe(true);
  });
  test("ignores binding/literal/formatString shapes", () => {
    expect(isA2uiFunctionCall({ path: "/a" })).toBe(false);
    expect(isA2uiFunctionCall({ $ref: "/a" })).toBe(false);
    expect(isA2uiFunctionCall({ literal: 1 })).toBe(false);
    expect(isA2uiFunctionCall({ formatString: "hi ${/name}" })).toBe(false);
  });
  test("ignores objects with multiple function keys", () => {
    expect(isA2uiFunctionCall({ if: {}, not: true })).toBe(false);
  });
  test("ignores non-objects", () => {
    expect(isA2uiFunctionCall("hi")).toBe(false);
    expect(isA2uiFunctionCall(null)).toBe(false);
    expect(isA2uiFunctionCall([1, 2])).toBe(false);
  });
});

describe("evaluateA2uiFunction", () => {
  const model = { name: "Ada", count: 2, items: [1, 2, 3], active: true, empty: "" };

  test("if uses then/else branches", () => {
    expect(
      evaluateA2uiFunction({ if: { cond: { path: "/active" }, then: "on", else: "off" } }, model),
    ).toBe("on");
    expect(
      evaluateA2uiFunction({ if: { cond: { path: "/missing" }, then: "on", else: "off" } }, model),
    ).toBe("off");
  });

  test("not inverts truthiness", () => {
    expect(evaluateA2uiFunction({ not: { path: "/active" } }, model)).toBe(false);
    expect(evaluateA2uiFunction({ not: { path: "/empty" } }, model)).toBe(true);
  });

  test("eq/neq compare deeply", () => {
    expect(evaluateA2uiFunction({ eq: [{ path: "/count" }, 2] }, model)).toBe(true);
    expect(evaluateA2uiFunction({ eq: [{ path: "/count" }, 3] }, model)).toBe(false);
    expect(evaluateA2uiFunction({ neq: [{ path: "/count" }, 3] }, model)).toBe(true);
  });

  test("and/or collapse lists", () => {
    expect(
      evaluateA2uiFunction({ and: [{ path: "/active" }, { eq: [{ path: "/count" }, 2] }] }, model),
    ).toBe(true);
    expect(
      evaluateA2uiFunction({ or: [{ path: "/empty" }, false, { path: "/active" }] }, model),
    ).toBe(true);
  });

  test("concat stringifies and joins", () => {
    expect(evaluateA2uiFunction({ concat: ["hi ", { path: "/name" }, "!"] }, model)).toBe(
      "hi Ada!",
    );
  });

  test("length works on arrays, strings, and objects", () => {
    expect(evaluateA2uiFunction({ length: { path: "/items" } }, model)).toBe(3);
    expect(evaluateA2uiFunction({ length: { path: "/name" } }, model)).toBe(3);
    expect(evaluateA2uiFunction({ length: { literal: { a: 1, b: 2 } } }, model)).toBe(2);
  });

  test("join glues array entries", () => {
    expect(
      evaluateA2uiFunction({ join: { items: { path: "/items" }, separator: "-" } }, model),
    ).toBe("1-2-3");
  });

  test("map applies a template over a list with scoped item binding", () => {
    const result = evaluateA2uiFunction(
      {
        map: {
          from: { path: "/items" },
          as: "it",
          template: { concat: ["#", { path: "/it" }] },
        },
      },
      model,
    );
    expect(result).toEqual(["#1", "#2", "#3"]);
  });

  test("coalesce returns the first non-empty value", () => {
    expect(
      evaluateA2uiFunction(
        { coalesce: [{ path: "/missing" }, { path: "/empty" }, "fallback"] },
        model,
      ),
    ).toBe("fallback");
  });

  test("resolveDynamicWithFunctions falls back to plain bindings", () => {
    expect(resolveDynamicWithFunctions({ path: "/name" }, model)).toBe("Ada");
    expect(resolveDynamicWithFunctions("literal", model)).toBe("literal");
  });

  test("depth limit prevents runaway recursion", () => {
    const ctor = (depth: number): any => {
      let node: any = { path: "/name" };
      for (let i = 0; i < depth; i++) node = { if: { cond: true, then: node } };
      return node;
    };
    // Should not throw even at very deep nesting.
    expect(() => evaluateA2uiFunction(ctor(200), model)).not.toThrow();
  });
});
