import { describe, expect, test } from "bun:test";

import { assertSafeWebUrl } from "../src/utils/webSafety";

describe("assertSafeWebUrl", () => {
  test("blocks loopback IPv6 URLs with bracketed hostnames", () => {
    expect(() => assertSafeWebUrl("http://[::1]/")).toThrow("Blocked private/internal host");
  });

  test("blocks unique-local IPv6 URLs with bracketed hostnames", () => {
    expect(() => assertSafeWebUrl("http://[fd00::1]/")).toThrow("Blocked private/internal host");
  });

  test("allows public HTTPS URLs", () => {
    expect(assertSafeWebUrl("https://example.com/").hostname).toBe("example.com");
  });
});
