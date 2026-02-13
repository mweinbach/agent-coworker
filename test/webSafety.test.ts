import { afterEach, describe, expect, test } from "bun:test";

import { __internal, assertSafeWebUrl, resolveSafeWebUrl } from "../src/utils/webSafety";

afterEach(() => {
  __internal.resetDnsLookup();
});

describe("assertSafeWebUrl", () => {
  test("blocks loopback IPv6 URLs with bracketed hostnames", async () => {
    await expect(assertSafeWebUrl("http://[::1]/")).rejects.toThrow(/private\/internal host/i);
  });

  test("blocks unique-local IPv6 URLs with bracketed hostnames", async () => {
    await expect(assertSafeWebUrl("http://[fd00::1]/")).rejects.toThrow(/private\/internal host/i);
  });

  test("blocks IPv4-mapped IPv6 loopback URLs", async () => {
    await expect(assertSafeWebUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(/private\/internal host/i);
    await expect(assertSafeWebUrl("http://[::ffff:7f00:1]/")).rejects.toThrow(/private\/internal host/i);
  });

  test("blocks IPv4-mapped IPv6 link-local metadata URLs", async () => {
    await expect(assertSafeWebUrl("http://[::ffff:169.254.169.254]/")).rejects.toThrow(
      /private\/internal host/i
    );
    await expect(assertSafeWebUrl("http://[::ffff:a9fe:a9fe]/")).rejects.toThrow(
      /private\/internal host/i
    );
  });

  test("allows IPv4-mapped IPv6 public URLs", async () => {
    expect((await assertSafeWebUrl("http://[::ffff:8.8.8.8]/")).hostname).toBe("[::ffff:808:808]");
    expect((await assertSafeWebUrl("http://[::ffff:808:808]/")).hostname).toBe(
      "[::ffff:808:808]"
    );
  });

  test("blocks trailing-dot localhost hostname", async () => {
    await expect(assertSafeWebUrl("http://localhost./")).rejects.toThrow(/private\/internal host/i);
  });

  test("blocks trailing-dot internal metadata hostname", async () => {
    await expect(assertSafeWebUrl("http://metadata.google.internal./")).rejects.toThrow(
      /private\/internal host/i
    );
  });

  test("blocks CGNAT range (100.64.x.x)", async () => {
    await expect(assertSafeWebUrl("http://100.64.0.1/")).rejects.toThrow(/private\/internal host/i);
    await expect(assertSafeWebUrl("http://100.127.255.254/")).rejects.toThrow(
      /private\/internal host/i
    );
  });

  test("blocks benchmark range (198.18.x.x)", async () => {
    await expect(assertSafeWebUrl("http://198.18.0.1/")).rejects.toThrow(/private\/internal host/i);
    await expect(assertSafeWebUrl("http://198.19.255.254/")).rejects.toThrow(
      /private\/internal host/i
    );
  });

  test("allows public HTTPS URLs", async () => {
    __internal.setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    expect((await assertSafeWebUrl("https://example.com/")).hostname).toBe("example.com");
  });

  test("blocks hostnames that resolve to private addresses", async () => {
    __internal.setDnsLookup(async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(assertSafeWebUrl("https://anything.example/")).rejects.toThrow(
      /private\/internal host/i
    );
  });

  test("allows hostnames that resolve only to public addresses", async () => {
    __internal.setDnsLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    expect((await assertSafeWebUrl("https://public.example/")).hostname).toBe("public.example");
  });


  test("returns resolved public addresses for pinned fetch use", async () => {
    __internal.setDnsLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    const resolved = await resolveSafeWebUrl("https://public.example/");
    expect(resolved.url.hostname).toBe("public.example");
    expect(resolved.addresses).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
  });
});
