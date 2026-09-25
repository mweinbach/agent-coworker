import { describe, expect, test } from "bun:test";

import { parsePluginMarketplace, parseRemotePluginMarketplace } from "../src/plugins/marketplace";

const VALID_HASH = `sha256:${"a".repeat(64)}`;

function remoteOpts() {
  return {
    marketplacePath: "https://github.com/acme/market/blob/main/marketplace.json",
    repo: "acme/market",
    ref: "main",
  };
}

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    name: "workspace-tools",
    source: { source: "local", path: "./plugins/workspace-tools" },
    policy: { installation: "AVAILABLE", authentication: "NONE" },
    category: "Productivity",
    ...overrides,
  };
}

describe("plugin marketplace parse fail-closed", () => {
  test("rejects invalid JSON, extras, and malformed source hashes", () => {
    expect(() => parseRemotePluginMarketplace("{", remoteOpts())).toThrow("invalid JSON");
    expect(() =>
      parseRemotePluginMarketplace(
        JSON.stringify({ name: "market", plugins: [], extra: true }),
        remoteOpts(),
      ),
    ).toThrow();
    expect(() =>
      parseRemotePluginMarketplace(
        JSON.stringify({
          name: "market",
          plugins: [validEntry({ sourceHash: `sha256:${"A".repeat(64)}` })],
        }),
        remoteOpts(),
      ),
    ).toThrow();
    expect(() =>
      parseRemotePluginMarketplace(
        JSON.stringify({
          name: "market",
          plugins: [validEntry({ sourceHash: `sha256:${"a".repeat(63)}` })],
        }),
        remoteOpts(),
      ),
    ).toThrow();
    expect(() =>
      parseRemotePluginMarketplace(
        JSON.stringify({
          name: "market",
          plugins: [validEntry({ sourceHash: "not-a-hash" })],
        }),
        remoteOpts(),
      ),
    ).toThrow();
  });

  test("rejects source paths that escape the marketplace root", () => {
    for (const path of ["plugins/escape", "./../escape", "./foo/../../escape", "./..", "/abs"]) {
      expect(() =>
        parseRemotePluginMarketplace(
          JSON.stringify({
            name: "market",
            plugins: [validEntry({ source: { source: "local", path } })],
          }),
          remoteOpts(),
        ),
      ).toThrow(/must start with "\.\/"|resolves outside marketplace root/);
    }
  });

  test("parsePluginMarketplace rejects local path escape before install", () => {
    expect(() =>
      parsePluginMarketplace(
        JSON.stringify({
          name: "local",
          plugins: [validEntry({ source: { source: "local", path: "./../secret" } })],
        }),
        "/workspace/.cowork/plugins/market/marketplace.json",
      ),
    ).toThrow("resolves outside marketplace root");
  });

  test("keeps a valid source hash and relative plugin path", () => {
    const doc = parseRemotePluginMarketplace(
      JSON.stringify({
        name: "market",
        plugins: [validEntry({ sourceHash: VALID_HASH })],
      }),
      remoteOpts(),
    );
    expect(doc.plugins).toEqual([
      expect.objectContaining({
        name: "workspace-tools",
        sourcePath: "plugins/workspace-tools",
        sourceHash: VALID_HASH,
        sourceInput: "https://github.com/acme/market/tree/main/plugins/workspace-tools",
      }),
    ]);
  });
});
