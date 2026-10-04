import { describe, expect, test } from "bun:test";
import { parsePluginMarketplace, parseRemotePluginMarketplace } from "../src/plugins/marketplace";

const VALID_HASH = `sha256:${"a".repeat(64)}`;
const remoteOpts = {
  marketplacePath: "https://github.com/acme/market/blob/main/marketplace.json",
  repo: "acme/market",
  ref: "main",
};
const validEntry = (overrides: Record<string, unknown> = {}) => ({
  name: "workspace-tools",
  source: { source: "local", path: "./plugins/workspace-tools" },
  policy: { installation: "AVAILABLE", authentication: "NONE" },
  category: "Productivity",
  ...overrides,
});

describe("plugin marketplace parse fail-closed", () => {
  test("rejects invalid JSON, extras, and malformed source hashes", () => {
    expect(() => parseRemotePluginMarketplace("{", remoteOpts)).toThrow("invalid JSON");
    for (const payload of [
      { name: "market", plugins: [], extra: true },
      { name: "market", plugins: [validEntry({ sourceHash: `sha256:${"A".repeat(64)}` })] },
      { name: "market", plugins: [validEntry({ sourceHash: `sha256:${"a".repeat(63)}` })] },
      { name: "market", plugins: [validEntry({ sourceHash: "not-a-hash" })] },
    ]) {
      expect(() => parseRemotePluginMarketplace(JSON.stringify(payload), remoteOpts)).toThrow();
    }
  });

  test("rejects source paths that escape the marketplace root", () => {
    for (const p of ["plugins/escape", "./../escape", "./foo/../../escape", "./..", "/abs"]) {
      expect(() =>
        parseRemotePluginMarketplace(
          JSON.stringify({
            name: "market",
            plugins: [validEntry({ source: { source: "local", path: p } })],
          }),
          remoteOpts,
        ),
      ).toThrow(/must start with "\.\/"|resolves outside marketplace root/);
    }
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
      JSON.stringify({ name: "market", plugins: [validEntry({ sourceHash: VALID_HASH })] }),
      remoteOpts,
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
