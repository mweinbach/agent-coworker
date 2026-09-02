import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { getAiCoworkerPaths } from "../../src/connect";
import { defaultModelIdForProvider, listSupportedModelIds } from "../../src/models/registry";
import { scratchRoots } from "../../src/platform/sandbox";
import { PROVIDER_MODEL_CATALOG } from "../../src/providers/catalog";
import {
  listProviderCatalogEntries,
  type ProviderCatalogEntry,
} from "../../src/providers/connectionCatalog";
import { PROVIDER_NAMES, type ProviderName } from "../../src/types";

const dynamicModelProviders = new Set<ProviderName>(["lmstudio"]);

const unavailableLmStudioFetch: typeof fetch = async () => {
  throw new Error("LM Studio unavailable in catalog registry parity test.");
};

async function isolatedCatalogEntries(): Promise<ProviderCatalogEntry[]> {
  const home = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "catalog-registry-parity-"));
  return await listProviderCatalogEntries({
    paths: getAiCoworkerPaths({ homedir: home }),
    env: {},
    lmstudioFetchImpl: unavailableLmStudioFetch,
    platform: "linux",
  });
}

describe("provider catalog registry parity", () => {
  test("provider model catalog mirrors the static registry", () => {
    expect(Object.keys(PROVIDER_MODEL_CATALOG).sort()).toEqual([...PROVIDER_NAMES].sort());

    for (const provider of PROVIDER_NAMES) {
      if (dynamicModelProviders.has(provider)) {
        expect(PROVIDER_MODEL_CATALOG[provider]).toEqual({
          defaultModel: "",
          availableModels: [],
        });
        continue;
      }

      expect(PROVIDER_MODEL_CATALOG[provider].defaultModel).toBe(
        defaultModelIdForProvider(provider),
      );
      expect(PROVIDER_MODEL_CATALOG[provider].availableModels).toEqual(
        listSupportedModelIds(provider),
      );
    }
  });

  test("bundled connection catalog exposes provider catalog model ids", async () => {
    const entries = await isolatedCatalogEntries();
    const entriesByProvider = new Map(entries.map((entry) => [entry.id, entry] as const));

    expect([...entriesByProvider.keys()]).toEqual(PROVIDER_NAMES);
    for (const provider of PROVIDER_NAMES) {
      const entry = entriesByProvider.get(provider);
      expect(entry).toBeDefined();
      const modelIds = entry?.models.map((model) => model.id) ?? [];
      expect(modelIds).toEqual(PROVIDER_MODEL_CATALOG[provider].availableModels);
      if (entry?.defaultModel) {
        expect(modelIds).toContain(entry.defaultModel);
      }
    }
  });
});
