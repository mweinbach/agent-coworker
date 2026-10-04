import { describe, expect, test } from "bun:test";
import { digestToolInput } from "../../src/shared/toolInputDigestHasher";

describe("digestToolInput", () => {
  test("is stable across object key order and changes with tool name or args", () => {
    const left = digestToolInput("write", { path: "a.ts", content: "hello" });
    expect(left?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(digestToolInput("write", { content: "hello", path: "a.ts" })).toEqual(left);
    expect(digestToolInput("read", { path: "a.ts", content: "hello" })).not.toEqual(left);
    expect(digestToolInput("write", { path: "b.ts", content: "hello" })).not.toEqual(left);
  });

  test("fails closed for undefined args, non-finite numbers, and cycles", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    for (const bad of [
      undefined,
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { skip: undefined },
      cycle,
    ]) {
      expect(digestToolInput("write", bad)).toBeNull();
    }
  });
});
