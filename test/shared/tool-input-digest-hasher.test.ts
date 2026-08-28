import { describe, expect, test } from "bun:test";

import { isToolInputDigest, sameToolInputDigest } from "../../src/shared/toolInputDigest";
import { digestToolInput } from "../../src/shared/toolInputDigestHasher";

describe("digestToolInput", () => {
  test("returns a stable sha256 digest regardless of object key order", () => {
    const left = digestToolInput("write", { content: "hello", path: "a.ts" });
    const right = digestToolInput("write", { path: "a.ts", content: "hello" });

    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(isToolInputDigest(left)).toBe(true);
    expect(sameToolInputDigest(left!, right!)).toBe(true);
    expect(left?.algorithm).toBe("sha256");
    expect(left?.value).toMatch(/^[a-f0-9]{64}$/);
    expect(left?.canonicalBytes).toBeGreaterThan(0);
  });

  test("changes the digest when the tool name or args change", () => {
    const write = digestToolInput("write", { path: "a.ts" });
    const read = digestToolInput("read", { path: "a.ts" });
    const otherPath = digestToolInput("write", { path: "b.ts" });

    expect(write?.value).not.toBe(read?.value);
    expect(write?.value).not.toBe(otherPath?.value);
    expect(sameToolInputDigest(write!, read!)).toBe(false);
  });

  test("fails closed for undefined, non-finite numbers, and circular graphs", () => {
    expect(digestToolInput("write", undefined)).toBeNull();
    expect(digestToolInput("write", { n: Number.NaN })).toBeNull();
    expect(digestToolInput("write", { n: Number.POSITIVE_INFINITY })).toBeNull();
    expect(digestToolInput("write", { n: Number.NEGATIVE_INFINITY })).toBeNull();

    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(digestToolInput("write", circular)).toBeNull();

    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(digestToolInput("bash", cycle)).toBeNull();
  });

  test("fails closed for functions, symbols, bigint, and nested undefined", () => {
    expect(digestToolInput("write", { fn: () => 1 })).toBeNull();
    expect(digestToolInput("write", { key: Symbol("x") })).toBeNull();
    expect(digestToolInput("write", { n: 1n })).toBeNull();
    expect(digestToolInput("write", { missing: undefined })).toBeNull();
  });

  test("hashes null, nested arrays, and empty objects", () => {
    expect(digestToolInput("write", null)).not.toBeNull();
    expect(digestToolInput("write", { items: [1, { ok: true }, "x"] })).not.toBeNull();
    expect(digestToolInput("write", {})).not.toBeNull();
    expect(isToolInputDigest({ algorithm: "sha256", value: "abc", canonicalBytes: 1 })).toBe(false);
    expect(
      isToolInputDigest({
        algorithm: "sha256",
        value: "a".repeat(64),
        canonicalBytes: 1,
        extra: true,
      }),
    ).toBe(false);
  });
});
