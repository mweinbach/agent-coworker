import { describe, expect, test } from "bun:test";

import { digestToolInput } from "../../src/shared/toolInputDigestHasher";

describe("digestToolInput", () => {
  test("is stable across object key order and changes with tool name or args", () => {
    const left = digestToolInput("write", { path: "a.ts", content: "hello" });
    const right = digestToolInput("write", { content: "hello", path: "a.ts" });
    expect(left).not.toBeNull();
    expect(right).toEqual(left);
    expect(left?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(digestToolInput("read", { path: "a.ts", content: "hello" })).not.toEqual(left);
    expect(digestToolInput("write", { path: "b.ts", content: "hello" })).not.toEqual(left);
  });

  test("fails closed for undefined args, non-finite numbers, and cycles", () => {
    expect(digestToolInput("write", undefined)).toBeNull();
    expect(digestToolInput("write", { n: Number.NaN })).toBeNull();
    expect(digestToolInput("write", { n: Number.POSITIVE_INFINITY })).toBeNull();
    expect(digestToolInput("write", { skip: undefined })).toBeNull();

    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(digestToolInput("write", cycle)).toBeNull();
  });
});
