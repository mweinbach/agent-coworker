import { describe, expect, test } from "bun:test";

import { assertSafeWebUrl } from "../src/utils/webSafety";

describe("assertSafeWebUrl", () => {
  test("blocks loopback IPv6 URLs with bracketed hostnames", () => {
    expect(() => assertSafeWebUrl("http://[::1]/")).toThrow("Blocked private/internal host");
  });

  test("blocks unique-local IPv6 URLs with bracketed hostnames", () => {
    expect(() => assertSafeWebUrl("http://[fd00::1]/")).toThrow("Blocked private/internal host");
  });

  test("blocks IPv4-mapped IPv6 loopback URLs", () => {
    expect(() => assertSafeWebUrl("http://[::ffff:127.0.0.1]/")).toThrow("Blocked private/internal host");
  });

  test("blocks trailing-dot localhost hostname", () => {
    expect(() => assertSafeWebUrl("http://localhost./")).toThrow("Blocked private/internal host");
  });

  test("blocks trailing-dot internal metadata hostname", () => {
    expect(() => assertSafeWebUrl("http://metadata.google.internal./")).toThrow("Blocked private/internal host");
  });

  test("allows public HTTPS URLs", () => {
    expect(assertSafeWebUrl("https://example.com/").hostname).toBe("example.com");
  });
});
