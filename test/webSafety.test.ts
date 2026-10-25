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
    await expect(assertSafeWebUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(
      /private\/internal host/i,
    );
    await expect(assertSafeWebUrl("http://[::ffff:7f00:1]/")).rejects.toThrow(
      /private\/internal host/i,
    );
  });

  test("blocks IPv4-mapped IPv6 link-local metadata URLs", async () => {
    await expect(assertSafeWebUrl("http://[::ffff:169.254.169.254]/")).rejects.toThrow(
      /private\/internal host/i,
    );
    await expect(assertSafeWebUrl("http://[::ffff:a9fe:a9fe]/")).rejects.toThrow(
      /private\/internal host/i,
    );
  });

  test("allows IPv4-mapped IPv6 public URLs", async () => {
    expect((await assertSafeWebUrl("http://[::ffff:8.8.8.8]/")).hostname).toBe("[::ffff:808:808]");
    expect((await assertSafeWebUrl("http://[::ffff:808:808]/")).hostname).toBe("[::ffff:808:808]");
  });

  test("blocks trailing-dot localhost hostname", async () => {
    await expect(assertSafeWebUrl("http://localhost./")).rejects.toThrow(/private\/internal host/i);
  });

  test("blocks trailing-dot internal metadata hostname", async () => {
    await expect(assertSafeWebUrl("http://metadata.google.internal./")).rejects.toThrow(
      /private\/internal host/i,
    );
  });

  test("blocks CGNAT range (100.64.x.x)", async () => {
    await expect(assertSafeWebUrl("http://100.64.0.1/")).rejects.toThrow(/private\/internal host/i);
    await expect(assertSafeWebUrl("http://100.127.255.254/")).rejects.toThrow(
      /private\/internal host/i,
    );
  });

  test("blocks benchmark range (198.18.x.x)", async () => {
    await expect(assertSafeWebUrl("http://198.18.0.1/")).rejects.toThrow(/private\/internal host/i);
    await expect(assertSafeWebUrl("http://198.19.255.254/")).rejects.toThrow(
      /private\/internal host/i,
    );
  });

  test("allows public HTTPS URLs", async () => {
    __internal.setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    expect((await assertSafeWebUrl("https://example.com/")).hostname).toBe("example.com");
  });

  test("blocks hostnames that resolve to private addresses", async () => {
    __internal.setDnsLookup(async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(assertSafeWebUrl("https://anything.example/")).rejects.toThrow(
      /private\/internal host/i,
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

  test("pins public IP literals without consulting DNS", async () => {
    __internal.setDnsLookup(async () => {
      throw new Error("DNS must not run for IP literals");
    });
    const ipv4 = await resolveSafeWebUrl("http://93.184.216.34/path");
    expect(ipv4.url.hostname).toBe("93.184.216.34");
    expect(ipv4.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    const ipv6 = await resolveSafeWebUrl("http://[2001:4860:4860::8888]/");
    expect(ipv6.url.hostname).toBe("[2001:4860:4860::8888]");
    expect(ipv6.addresses).toEqual([{ address: "2001:4860:4860::8888", family: 6 }]);
  });

  test.each([
    ["decimal loopback", "http://2130706433/"],
    ["hex loopback", "http://0x7f000001/"],
    ["dotted hex loopback", "http://0x7f.0.0.1/"],
    ["octal loopback", "http://0177.0.0.1/"],
    ["short loopback", "http://127.1/"],
    ["leading-zero loopback", "http://127.0.0.01/"],
    ["trailing-dot loopback", "http://127.0.0.1./"],
    ["this-host", "http://0.0.0.0/"],
    ["private 10/8", "http://10.255.255.255/"],
    ["private 172.16/12 lower edge", "http://172.16.0.0/"],
    ["private 172.16/12 upper edge", "http://172.31.255.255/"],
    ["RFC1918 192.168/16", "http://192.168.0.1/"],
    ["link-local metadata", "http://169.254.169.254/"],
    ["multicast", "http://224.0.0.0/"],
    ["limited broadcast", "http://255.255.255.255/"],
    ["unspecified IPv6", "http://[::]/"],
    ["unique-local fc00::/7", "http://[fc00::1]/"],
    ["link-local fe80", "http://[fe80::1]/"],
    ["link-local fe90", "http://[fe90::1]/"],
    ["link-local fea0", "http://[fea0::1]/"],
    ["link-local feb0", "http://[feb0::1]/"],
    ["uppercase link-local", "http://[FE80::1]/"],
    ["IPv6 multicast", "http://[ff02::1]/"],
    ["mapped private 10/8", "http://[::ffff:10.0.0.1]/"],
    ["mapped private 172.16/12", "http://[::ffff:172.16.0.1]/"],
    ["mapped RFC1918 192.168/16", "http://[::ffff:192.168.0.1]/"],
    ["mapped this-host", "http://[::ffff:0.0.0.0]/"],
    ["mapped multicast", "http://[::ffff:224.0.0.1]/"],
  ])("blocks %s before DNS (%s)", async (_label, url) => {
    __internal.setDnsLookup(async () => {
      throw new Error("DNS must not run for a blocked literal");
    });
    await expect(assertSafeWebUrl(url)).rejects.toThrow(/private\/internal host/i);
  });

  test.each([
    ["just below 10/8", "http://9.255.255.255/", "9.255.255.255"],
    ["just above 10/8", "http://11.0.0.1/", "11.0.0.1"],
    ["just below 172.16/12", "http://172.15.255.255/", "172.15.255.255"],
    ["just above 172.16/12", "http://172.32.0.0/", "172.32.0.0"],
    ["just below 192.168/16", "http://192.167.255.255/", "192.167.255.255"],
    ["just above 192.168/16", "http://192.169.0.1/", "192.169.0.1"],
    ["just above link-local", "http://169.255.1.1/", "169.255.1.1"],
    ["just below CGNAT", "http://100.63.255.255/", "100.63.255.255"],
    ["just above CGNAT", "http://100.128.0.1/", "100.128.0.1"],
    ["just below benchmark", "http://198.17.255.255/", "198.17.255.255"],
    ["just above benchmark", "http://198.20.0.1/", "198.20.0.1"],
    ["just below multicast", "http://223.255.255.255/", "223.255.255.255"],
  ])("allows the public address just outside %s", async (_label, url, hostname) => {
    __internal.setDnsLookup(async () => {
      throw new Error("DNS must not run for IP literals");
    });
    expect((await assertSafeWebUrl(url)).hostname).toBe(hostname);
  });

  test.each([
    "http://LOCALHOST/",
    "http://foo.localhost/",
    "http://foo.localhost./",
    "http://foo.local./",
    "http://foo.internal/",
    "http://host.docker.internal/",
    "http://metadata/",
    "http://metadata.aws.internal/",
  ])("blocks reserved hostname %s before DNS", async (url) => {
    __internal.setDnsLookup(async () => {
      throw new Error("DNS must not run for a reserved host");
    });
    await expect(assertSafeWebUrl(url)).rejects.toThrow(/private\/internal host/i);
  });

  test.each([
    "http://notlocal/",
    "http://localhost.example.com/",
    "http://internal.example.com/",
    "http://metadata.google.internal.evil.com/",
    "http://foo.localhost.example.com/",
  ])("does not treat lookalike hostname %s as reserved", async (url) => {
    __internal.setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    expect((await assertSafeWebUrl(url)).hostname).toBe(new URL(url).hostname);
  });

  test.each([
    "http://user:pass@example.com/secret",
    "http://user@example.com/",
    "https://:secret@example.com/",
  ])("blocks credentials in %s before DNS", async (url) => {
    __internal.setDnsLookup(async () => {
      throw new Error("DNS must not run for a credentialed URL");
    });
    await expect(assertSafeWebUrl(url)).rejects.toThrow("Blocked URL credentials in authority");
  });

  test.each([
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ws://example.com/",
  ])("blocks non-http protocol %s", async (url) => {
    await expect(assertSafeWebUrl(url)).rejects.toThrow(/Blocked URL protocol:/);
  });

  test("blocks a hostname when any resolved address is private", async () => {
    const cases = [
      [
        { address: "93.184.216.34", family: 4 },
        { address: "10.1.2.3", family: 4 },
      ],
      [
        { address: "192.168.1.1", family: 4 },
        { address: "93.184.216.34", family: 4 },
      ],
      [
        { address: "93.184.216.34", family: 4 },
        { address: "::ffff:127.0.0.1", family: 6 },
      ],
      [
        { address: "2001:4860:4860::8888", family: 6 },
        { address: "fd00::1", family: 6 },
      ],
    ];
    for (const addresses of cases) {
      __internal.setDnsLookup(async () => addresses);
      await expect(assertSafeWebUrl("https://rebind.example/path")).rejects.toThrow(
        "Blocked private/internal host: rebind.example",
      );
    }
  });

  test("blocks a hostname whose DNS lookup returns no addresses", async () => {
    __internal.setDnsLookup(async () => []);
    await expect(resolveSafeWebUrl("https://missing.example/path")).rejects.toThrow(
      "Blocked unresolved host: missing.example",
    );
  });

  test("propagates DNS lookup failures instead of allowing the fetch", async () => {
    __internal.setDnsLookup(async () => {
      throw new Error("dns timeout");
    });
    await expect(assertSafeWebUrl("https://public.example/")).rejects.toThrow("dns timeout");
  });
});
