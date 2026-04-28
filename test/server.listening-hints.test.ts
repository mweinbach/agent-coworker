import { describe, expect, test } from "bun:test";

import { resolveListeningHintsFromInterfaces } from "../src/server/index";

describe("server listening hints", () => {
  test("includes non-internal IPv6 addresses for wildcard mobile H3 hosts", () => {
    expect(
      resolveListeningHintsFromInterfaces("0.0.0.0", {
        en0: [
          {
            address: "192.168.1.10",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "192.168.1.10/24",
          },
          {
            address: "2001:db8::10",
            netmask: "ffff:ffff:ffff:ffff::",
            family: "IPv6",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "2001:db8::10/64",
            scopeid: 0,
          },
        ],
        lo0: [
          {
            address: "::1",
            netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
            family: "IPv6",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "::1/128",
            scopeid: 0,
          },
        ],
      }),
    ).toEqual(["192.168.1.10", "2001:db8::10"]);
  });
});
