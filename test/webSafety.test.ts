import { describe, expect, test } from "bun:test";

import { assertSafeWebUrl } from "../src/utils/webSafety";

describe("assertSafeWebUrl", () => {
  test("blocks loopback IPv6 URLs with bracketed hostnames", () => {
    expect(() => assertSafeWebUrl("http://[::1]/")).toThrow(/private\/internal host/i);
  });

  test("blocks unique-local IPv6 URLs with bracketed hostnames", () => {
    expect(() => assertSafeWebUrl("http://[fd00::1]/")).toThrow(/private\/internal host/i);
  });

  test("blocks IPv4-mapped IPv6 loopback URLs", () => {
    expect(() => assertSafeWebUrl("http://[::ffff:127.0.0.1]/")).toThrow(/private\/internal host/i);
    expect(() => assertSafeWebUrl("http://[::ffff:7f00:1]/")).toThrow(/private\/internal host/i);
  });

  test("blocks IPv4-mapped IPv6 link-local metadata URLs", () => {
    expect(() => assertSafeWebUrl("http://[::ffff:169.254.169.254]/")).toThrow(
      /private\/internal host/i
    );
    expect(() => assertSafeWebUrl("http://[::ffff:a9fe:a9fe]/")).toThrow(/private\/internal host/i);
  });

  test("allows IPv4-mapped IPv6 public URLs", () => {
    expect(assertSafeWebUrl("http://[::ffff:8.8.8.8]/").hostname).toBe("[::ffff:808:808]");
    expect(assertSafeWebUrl("http://[::ffff:808:808]/").hostname).toBe("[::ffff:808:808]");
  });

  test("blocks trailing-dot localhost hostname", () => {
    expect(() => assertSafeWebUrl("http://localhost./")).toThrow(/private\/internal host/i);
  });

  test("blocks trailing-dot internal metadata hostname", () => {
    expect(() => assertSafeWebUrl("http://metadata.google.internal./")).toThrow(
      /private\/internal host/i
    );
  });

  test("allows public HTTPS URLs", () => {
    expect(assertSafeWebUrl("https://example.com/").hostname).toBe("example.com");
  });
});
