import { describe, expect, test } from "bun:test";

import {
  BUILT_IN_MARKETPLACE_REPO,
  isBuiltInMarketplaceSourceInput,
  normalizeInstallSourceInput,
} from "../src/plugins/remoteMarketplace";

const BUILT_IN_MARKETPLACE_URL = `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/main`;

describe("marketplace install source identity", () => {
  test("collapses blank and trailing-slash variants without folding case", () => {
    for (const blank of [undefined, null, "", "   ", "///"]) {
      expect(normalizeInstallSourceInput(blank)).toBeNull();
    }

    const source = "https://github.com/Acme/Plugins/tree/Main";
    expect(normalizeInstallSourceInput(`  ${source}///  `)).toBe(source);
    expect(normalizeInstallSourceInput(source.toLowerCase())).not.toBe(source);
  });

  test("recognizes only the built-in marketplace URL and its child paths", () => {
    expect(isBuiltInMarketplaceSourceInput(undefined)).toBe(false);
    expect(isBuiltInMarketplaceSourceInput("")).toBe(false);
    expect(isBuiltInMarketplaceSourceInput("   ")).toBe(false);
    expect(isBuiltInMarketplaceSourceInput(`  ${BUILT_IN_MARKETPLACE_URL}/  `)).toBe(true);
    expect(
      isBuiltInMarketplaceSourceInput(`${BUILT_IN_MARKETPLACE_URL}/plugins/workspace-tools`),
    ).toBe(true);

    expect(isBuiltInMarketplaceSourceInput(`${BUILT_IN_MARKETPLACE_URL}2`)).toBe(false);
    expect(isBuiltInMarketplaceSourceInput(`${BUILT_IN_MARKETPLACE_URL}.evil`)).toBe(false);
    expect(isBuiltInMarketplaceSourceInput(`${BUILT_IN_MARKETPLACE_URL}?ref=other`)).toBe(false);
    expect(isBuiltInMarketplaceSourceInput(BUILT_IN_MARKETPLACE_URL.toUpperCase())).toBe(false);
    expect(
      isBuiltInMarketplaceSourceInput(
        "https://github.com/other/cowork-skills-plugins/tree/main/plugins/workspace-tools",
      ),
    ).toBe(false);
  });
});
