import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getKnownResolvedModelMetadata,
  isConfiguredCustomModelIdSync,
  isDiscoveredModelIdSync,
  normalizeModelIdForProvider,
  resolveModelMetadata,
} from "../src/models/metadata";
import { upsertCustomModel } from "../src/providers/customModels";
import { writeModelDiscoveryCache } from "../src/providers/modelDiscoveryCache";
import { getAiCoworkerPaths } from "../src/store/connections";

// "zai-org/GLM-5" is registered in the Baseten and Together static registries,
// so it is provably foreign to nvidia unless configured as a custom model.
const CROSS_PROVIDER_ID = "zai-org/GLM-5";
const CUSTOM_ONLY_ID = "acme/experimental-model-1";
const BEDROCK_CUSTOM_ID = "us.acme.custom-bedrock-v1:0";
// A Bedrock id present only in the discovery snapshot (e.g. a provisioned or
// imported ARN not in the static registry and not in the custom-model store).
const BEDROCK_DISCOVERED_ID = "us.acme.discovered-bedrock-v1:0";
// A discovered id lives only in the discovery cache: not in the static
// registry and not in the custom-model store.
const DISCOVERED_ID = "acme/discovered-only-1";
const DISCOVERED_MODEL_FIELD_ID = "acme/discovered-model-field";

async function writeBedrockDiscoverySnapshot(homedir: string, modelId: string): Promise<void> {
  const paths = getAiCoworkerPaths({ homedir });
  await fs.mkdir(paths.configDir, { recursive: true });
  const cacheFile = {
    version: 1,
    snapshots: {
      "test-fingerprint": {
        authFingerprint: "test-fingerprint",
        updatedAt: new Date().toISOString(),
        models: [
          {
            id: modelId,
            displayName: "Discovered Bedrock",
            knowledgeCutoff: "Unknown",
            supportsImageInput: false,
            sourceKind: "provisioned",
          },
        ],
      },
    },
  };
  await fs.writeFile(
    path.join(paths.configDir, "bedrock-models.json"),
    JSON.stringify(cacheFile),
    "utf-8",
  );
}

let homeWithStore: string;
let emptyHome: string;

beforeAll(async () => {
  homeWithStore = await fs.mkdtemp(path.join(os.tmpdir(), "custom-model-resolution-"));
  emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "custom-model-resolution-empty-"));
  const paths = getAiCoworkerPaths({ homedir: homeWithStore });
  await upsertCustomModel(paths, "nvidia", CROSS_PROVIDER_ID);
  await upsertCustomModel(paths, "anthropic", CUSTOM_ONLY_ID);
  await upsertCustomModel(paths, "bedrock", BEDROCK_CUSTOM_ID);
  await writeBedrockDiscoverySnapshot(homeWithStore, BEDROCK_DISCOVERED_ID);
  await writeModelDiscoveryCache(paths, "openai", {
    provider: "openai",
    source: "api",
    models: [
      { id: DISCOVERED_ID, displayName: "Discovered Only" },
      {
        id: DISCOVERED_MODEL_FIELD_ID,
        model: DISCOVERED_MODEL_FIELD_ID,
        displayName: "Model Field",
      },
    ],
  });
});

afterAll(async () => {
  await fs.rm(homeWithStore, { recursive: true, force: true });
  await fs.rm(emptyHome, { recursive: true, force: true });
});

describe("isConfiguredCustomModelIdSync", () => {
  test("finds configured ids and rejects everything else", () => {
    expect(
      isConfiguredCustomModelIdSync("nvidia", CROSS_PROVIDER_ID, { home: homeWithStore }),
    ).toBe(true);
    expect(
      isConfiguredCustomModelIdSync("nvidia", `  ${CROSS_PROVIDER_ID}  `, { home: homeWithStore }),
    ).toBe(true);
    expect(
      isConfiguredCustomModelIdSync("baseten", CROSS_PROVIDER_ID, { home: homeWithStore }),
    ).toBe(false);
    expect(isConfiguredCustomModelIdSync("nvidia", "other-model", { home: homeWithStore })).toBe(
      false,
    );
    expect(isConfiguredCustomModelIdSync("nvidia", CROSS_PROVIDER_ID, { home: emptyHome })).toBe(
      false,
    );
  });

  test("returns false for providers without custom model id support", () => {
    expect(
      isConfiguredCustomModelIdSync("lmstudio", CROSS_PROVIDER_ID, { home: homeWithStore }),
    ).toBe(false);
    expect(
      isConfiguredCustomModelIdSync("codex-cli", CROSS_PROVIDER_ID, { home: homeWithStore }),
    ).toBe(false);
  });
});

describe("isDiscoveredModelIdSync", () => {
  test("finds ids present in the discovery cache and rejects everything else", () => {
    expect(isDiscoveredModelIdSync("openai", DISCOVERED_ID, { home: homeWithStore })).toBe(true);
    // Trailing/leading whitespace is trimmed before matching.
    expect(isDiscoveredModelIdSync("openai", `  ${DISCOVERED_ID}  `, { home: homeWithStore })).toBe(
      true,
    );
    // Matches against the `model` field too, not just `id`.
    expect(
      isDiscoveredModelIdSync("openai", DISCOVERED_MODEL_FIELD_ID, { home: homeWithStore }),
    ).toBe(true);
    expect(isDiscoveredModelIdSync("openai", "not-in-cache", { home: homeWithStore })).toBe(false);
    // Wrong provider's cache does not contain the id.
    expect(isDiscoveredModelIdSync("nvidia", DISCOVERED_ID, { home: homeWithStore })).toBe(false);
    // A home without any discovery cache reads as "not discovered".
    expect(isDiscoveredModelIdSync("openai", DISCOVERED_ID, { home: emptyHome })).toBe(false);
  });
});

describe("normalizeModelIdForProvider with custom model ids", () => {
  test("accepts a configured custom id that is registered under another provider", () => {
    expect(
      normalizeModelIdForProvider("nvidia", CROSS_PROVIDER_ID, "model", { home: homeWithStore }),
    ).toBe(CROSS_PROVIDER_ID);
  });

  test("still rejects foreign ids that are not configured as custom models", () => {
    expect(() =>
      normalizeModelIdForProvider("nvidia", CROSS_PROVIDER_ID, "model", { home: emptyHome }),
    ).toThrow(/Unsupported model/);
    expect(() =>
      normalizeModelIdForProvider("minimax", CROSS_PROVIDER_ID, "model", { home: homeWithStore }),
    ).toThrow(/Unsupported model/);
  });
});

describe("resolveModelMetadata with allowPlaceholder + custom model ids", () => {
  test("accepts a configured custom cross-registry id under a non-default home (prompt load path)", async () => {
    // Prompt loading before every turn calls resolveModelMetadata with
    // allowPlaceholder: true. Before threading opts.home into the placeholder
    // fall-through, the sync normalizer read the process home's (empty) custom
    // store and rejected the foreign id, aborting the turn before the runtime
    // fallback could run.
    const resolved = await resolveModelMetadata("nvidia", CROSS_PROVIDER_ID, {
      allowPlaceholder: true,
      source: "model",
      home: homeWithStore,
    });
    expect(resolved.id).toBe(CROSS_PROVIDER_ID);
    expect(resolved.provider).toBe("nvidia");
  });

  test("still rejects a foreign id when the session home lacks the custom store", async () => {
    await expect(
      resolveModelMetadata("nvidia", CROSS_PROVIDER_ID, {
        allowPlaceholder: true,
        source: "model",
        home: emptyHome,
      }),
    ).rejects.toThrow(/Unsupported model/);
  });
});

describe("getKnownResolvedModelMetadata with custom model ids", () => {
  test("resolves configured custom ids instead of migrating to the default", () => {
    const resolved = getKnownResolvedModelMetadata("anthropic", CUSTOM_ONLY_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(CUSTOM_ONLY_ID);
    expect(resolved?.provider).toBe("anthropic");
    expect(resolved?.source).toBe("dynamic");
  });

  test("resolves custom ids that are foreign to the provider's registry", () => {
    const resolved = getKnownResolvedModelMetadata("nvidia", CROSS_PROVIDER_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(CROSS_PROVIDER_ID);
    expect(resolved?.provider).toBe("nvidia");
  });

  test("resolves discovered ids from the discovery cache instead of migrating to the default", () => {
    const resolved = getKnownResolvedModelMetadata("openai", DISCOVERED_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(DISCOVERED_ID);
    expect(resolved?.provider).toBe("openai");
    expect(resolved?.source).toBe("dynamic");
  });

  test("does not resolve discovered ids when the session home lacks the cache", () => {
    expect(getKnownResolvedModelMetadata("openai", DISCOVERED_ID, { home: emptyHome })).toBeNull();
  });

  test("returns null for unknown ids that are not configured", () => {
    expect(
      getKnownResolvedModelMetadata("anthropic", CUSTOM_ONLY_ID, { home: emptyHome }),
    ).toBeNull();
    expect(
      getKnownResolvedModelMetadata("nvidia", "not-configured-model", { home: homeWithStore }),
    ).toBeNull();
  });

  test("static registry models still resolve as static", () => {
    const resolved = getKnownResolvedModelMetadata("baseten", CROSS_PROVIDER_ID, {
      home: emptyHome,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.source).toBe("static");
  });

  test("resolves configured bedrock custom ids missing from the snapshot", () => {
    const resolved = getKnownResolvedModelMetadata("bedrock", BEDROCK_CUSTOM_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(BEDROCK_CUSTOM_ID);
    expect(resolved?.provider).toBe("bedrock");

    expect(
      getKnownResolvedModelMetadata("bedrock", BEDROCK_CUSTOM_ID, { home: emptyHome }),
    ).toBeNull();
  });

  test("resolves a discovered bedrock id from the snapshot under a non-default home", () => {
    // The discovery snapshot lives only under homeWithStore. Before threading
    // opts.home into getKnownBedrockResolvedModelMetadataSync, this read the
    // process home's (empty) cache and returned null, migrating the session to
    // the provider default on resume.
    const resolved = getKnownResolvedModelMetadata("bedrock", BEDROCK_DISCOVERED_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(BEDROCK_DISCOVERED_ID);
    expect(resolved?.provider).toBe("bedrock");
    expect(resolved?.source).toBe("dynamic");

    // A home without the discovery snapshot cannot resolve the discovered id.
    expect(
      getKnownResolvedModelMetadata("bedrock", BEDROCK_DISCOVERED_ID, { home: emptyHome }),
    ).toBeNull();
  });
});
