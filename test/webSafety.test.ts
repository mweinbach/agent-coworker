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

  test("rejects non-http protocols and embedded credentials before DNS", async () => {
    const calls: string[] = [];
    __internal.setDnsLookup(async (hostname) => {
      calls.push(hostname);
      return [{ address: "93.184.216.34", family: 4 }];
    });

    await expect(assertSafeWebUrl("javascript:alert(1)")).rejects.toThrow(
      "Blocked URL protocol: javascript:",
    );
    await expect(assertSafeWebUrl("file:///etc/passwd")).rejects.toThrow(
      "Blocked URL protocol: file:",
    );
    await expect(assertSafeWebUrl("ftp://files.example/drop")).rejects.toThrow(
      "Blocked URL protocol: ftp:",
    );
    await expect(assertSafeWebUrl("ws://example.com/socket")).rejects.toThrow(
      "Blocked URL protocol: ws:",
    );
    await expect(assertSafeWebUrl("wss://example.com/socket")).rejects.toThrow(
      "Blocked URL protocol: wss:",
    );
    await expect(assertSafeWebUrl("https://user:secret@example.com/a")).rejects.toThrow(
      "Blocked URL credentials in authority",
    );
    await expect(assertSafeWebUrl("https://:secret@example.com/a")).rejects.toThrow(
      "Blocked URL credentials in authority",
    );
    await expect(assertSafeWebUrl("https://user@example.com/a")).rejects.toThrow(
      "Blocked URL credentials in authority",
    );
    await expect(assertSafeWebUrl("https://example.com@evil.com/a")).rejects.toThrow(
      "Blocked URL credentials in authority",
    );
    expect(calls).toEqual([]);
  });

  test("treats empty userinfo as no credentials and still resolves the host", async () => {
    const calls: string[] = [];
    __internal.setDnsLookup(async (hostname) => {
      calls.push(hostname);
      return [{ address: "93.184.216.34", family: 4 }];
    });

    expect((await assertSafeWebUrl("https://@example.com/path")).hostname).toBe("example.com");
    expect(calls).toEqual(["example.com"]);
  });

  test.each([
    ["http://127.0.0.1/", "127.0.0.1"],
    ["http://2130706433/", "127.0.0.1"],
    ["http://0x7f000001/", "127.0.0.1"],
    ["http://0177.0.0.1/", "127.0.0.1"],
    ["http://127.1/", "127.0.0.1"],
    ["http://0x7f.0.0.1/", "127.0.0.1"],
    ["http://0.0.0.0/", "0.0.0.0"],
    ["http://10.0.0.1/", "10.0.0.1"],
    ["http://10.255.255.255/", "10.255.255.255"],
    ["http://172.16.0.0/", "172.16.0.0"],
    ["http://172.31.255.255/", "172.31.255.255"],
    ["http://192.168.0.1/", "192.168.0.1"],
    ["http://169.254.169.254/", "169.254.169.254"],
    ["http://100.64.0.0/", "100.64.0.0"],
    ["http://100.127.255.255/", "100.127.255.255"],
    ["http://198.18.0.0/", "198.18.0.0"],
    ["http://198.19.255.255/", "198.19.255.255"],
    ["http://224.0.0.0/", "224.0.0.0"],
    ["http://255.255.255.255/", "255.255.255.255"],
    ["http://LOCALHOST/", "localhost"],
    ["http://App.LocalHost/", "app.localhost"],
    ["http://printer.local/", "printer.local"],
    ["http://corp.internal/", "corp.internal"],
    ["http://METADATA/", "metadata"],
    ["http://Host.Docker.Internal/", "host.docker.internal"],
    ["http://[::]/", "[::]"],
    ["http://[fe80::1]/", "[fe80::1]"],
    ["http://[fe90::1]/", "[fe90::1]"],
    ["http://[fea0::1]/", "[fea0::1]"],
    ["http://[feb0::1]/", "[feb0::1]"],
    ["http://[fc00::1]/", "[fc00::1]"],
    ["http://[ff02::1]/", "[ff02::1]"],
    ["http://[::ffff:10.0.0.1]/", "[::ffff:a00:1]"],
    ["http://[::ffff:0:0]/", "[::ffff:0:0]"],
  ] as const)("blocks %s before DNS as %s", async (url, hostname) => {
    const calls: string[] = [];
    __internal.setDnsLookup(async (lookedUp) => {
      calls.push(lookedUp);
      return [{ address: "93.184.216.34", family: 4 }];
    });

    await expect(assertSafeWebUrl(url)).rejects.toThrow(
      `Blocked private/internal host: ${hostname}`,
    );
    expect(calls).toEqual([]);
  });

  test.each([
    ["http://8.8.8.8/dns", "8.8.8.8"],
    ["http://9.255.255.255/", "9.255.255.255"],
    ["http://11.0.0.0/", "11.0.0.0"],
    ["http://100.63.255.255/", "100.63.255.255"],
    ["http://100.128.0.1/", "100.128.0.1"],
    ["http://169.253.255.255/", "169.253.255.255"],
    ["http://169.255.0.0/", "169.255.0.0"],
    ["http://172.15.255.255/", "172.15.255.255"],
    ["http://172.32.0.1/", "172.32.0.1"],
    ["http://192.167.255.255/", "192.167.255.255"],
    ["http://192.169.0.1/", "192.169.0.1"],
    ["http://198.17.255.255/", "198.17.255.255"],
    ["http://198.20.0.1/", "198.20.0.1"],
    ["http://223.255.255.255/", "223.255.255.255"],
    ["http://[2001:4860:4860::8888]/", "[2001:4860:4860::8888]"],
  ] as const)("allows public literal %s without DNS", async (url, hostname) => {
    const calls: string[] = [];
    __internal.setDnsLookup(async (lookedUp) => {
      calls.push(lookedUp);
      return [{ address: "203.0.113.10", family: 4 }];
    });

    expect((await assertSafeWebUrl(url)).hostname).toBe(hostname);
    expect(calls).toEqual([]);
  });

  test("pins public IP literals to the literal address", async () => {
    const calls: string[] = [];
    __internal.setDnsLookup(async (hostname) => {
      calls.push(hostname);
      return [{ address: "203.0.113.10", family: 4 }];
    });

    await expect(resolveSafeWebUrl("http://1.1.1.1/dns")).resolves.toMatchObject({
      addresses: [{ address: "1.1.1.1", family: 4 }],
    });
    await expect(resolveSafeWebUrl("http://[2001:4860:4860::8888]/dns")).resolves.toMatchObject({
      addresses: [{ address: "2001:4860:4860::8888", family: 6 }],
    });
    expect(calls).toEqual([]);
  });

  test.each([
    "https://localhost.example/a",
    "https://foo.localhost.example/a",
    "https://notlocalhost/a",
  ] as const)("resolves %s because it is not a special-use suffix", async (url) => {
    const calls: string[] = [];
    __internal.setDnsLookup(async (hostname) => {
      calls.push(hostname);
      return [{ address: "93.184.216.34", family: 4 }];
    });

    const hostname = new URL(url).hostname;
    expect((await assertSafeWebUrl(url)).hostname).toBe(hostname);
    expect(calls).toEqual([hostname]);
  });

  test("blocks a hostname when DNS returns no addresses", async () => {
    __internal.setDnsLookup(async () => []);
    await expect(resolveSafeWebUrl("https://missing.example/path")).rejects.toThrow(
      "Blocked unresolved host: missing.example",
    );
  });

  test("blocks a hostname when any DNS answer is private", async () => {
    __internal.setDnsLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.1.2.3", family: 4 },
    ]);
    await expect(assertSafeWebUrl("https://rebind.example/x")).rejects.toThrow(
      "Blocked private/internal host: rebind.example",
    );

    __internal.setDnsLookup(async () => [
      { address: "2001:4860:4860::8888", family: 6 },
      { address: "fd00::1", family: 6 },
    ]);
    await expect(assertSafeWebUrl("https://rebind-v6.example/x")).rejects.toThrow(
      "Blocked private/internal host: rebind-v6.example",
    );

    __internal.setDnsLookup(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "::ffff:192.168.1.50", family: 6 },
    ]);
    await expect(assertSafeWebUrl("https://rebind-mapped.example/x")).rejects.toThrow(
      "Blocked private/internal host: rebind-mapped.example",
    );
  });
});
