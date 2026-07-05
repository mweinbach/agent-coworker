import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getDiscoveredModelMetadataSync,
  getKnownResolvedModelMetadata,
  getResolvedModelMetadataSync,
  isConfiguredCustomModelIdSync,
  modelSupportsImageInputSync,
  normalizeModelIdForProvider,
  reconcileReasoningProviderOptions,
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
// A discovered vision model that advertises image input in the cache; a
// reopened session must preserve `supportsImageInput: true` rather than
// downgrading to the generic placeholder's `false`.
const DISCOVERED_VISION_ID = "acme/discovered-vision-1";
// A discovered reasoning model that advertises reasoning info in the cache;
// its resolved metadata must keep the provider default's reasoning options.
const DISCOVERED_REASONING_ID = "acme/discovered-reasoning-1";
// A discovered reasoning model whose cached default effort ("medium") differs
// from the OpenAI provider fallback ("high"); the resolved defaults must honor
// the cached effort so config loading / child routing send the right payload.
const DISCOVERED_REASONING_MEDIUM_ID = "acme/discovered-reasoning-medium";
// An id present in BOTH the custom store and the discovery cache (as a vision
// model). Selection/resume must prefer the richer discovered metadata over the
// generic custom placeholder so it is not downgraded to text-only.
const DISCOVERED_AND_CUSTOM_VISION_ID = "acme/dup-vision-1";
// Custom OpenAI ids: a non-reasoning family id must NOT inherit reasoning
// defaults, while a reasoning-family id must keep them.
const CUSTOM_OPENAI_NON_REASONING_ID = "gpt-4o";
const CUSTOM_OPENAI_REASONING_ID = "o3-preview-custom";

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
  await upsertCustomModel(paths, "openai", CUSTOM_OPENAI_NON_REASONING_ID);
  await upsertCustomModel(paths, "openai", CUSTOM_OPENAI_REASONING_ID);
  await upsertCustomModel(paths, "openai", DISCOVERED_AND_CUSTOM_VISION_ID);
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
      {
        id: DISCOVERED_VISION_ID,
        displayName: "Discovered Vision",
        knowledgeCutoff: "January 1, 2025",
        supportsImageInput: true,
      },
      {
        id: DISCOVERED_REASONING_ID,
        displayName: "Discovered Reasoning",
        reasoning: { defaultEffort: "high", availableEfforts: ["low", "medium", "high"] },
      },
      {
        id: DISCOVERED_REASONING_MEDIUM_ID,
        displayName: "Discovered Reasoning Medium",
        reasoning: { defaultEffort: "medium", availableEfforts: ["low", "medium", "high"] },
      },
      {
        id: DISCOVERED_AND_CUSTOM_VISION_ID,
        displayName: "Dup Vision",
        knowledgeCutoff: "January 1, 2025",
        supportsImageInput: true,
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

describe("getDiscoveredModelMetadataSync", () => {
  test("finds ids present in the discovery cache and rejects everything else", () => {
    expect(
      getDiscoveredModelMetadataSync("openai", DISCOVERED_ID, { home: homeWithStore })?.id,
    ).toBe(DISCOVERED_ID);
    // Trailing/leading whitespace is trimmed before matching.
    expect(
      getDiscoveredModelMetadataSync("openai", `  ${DISCOVERED_ID}  `, { home: homeWithStore })?.id,
    ).toBe(DISCOVERED_ID);
    // Matches against the `model` field too, not just `id`.
    expect(
      getDiscoveredModelMetadataSync("openai", DISCOVERED_MODEL_FIELD_ID, { home: homeWithStore })
        ?.id,
    ).toBe(DISCOVERED_MODEL_FIELD_ID);
    expect(
      getDiscoveredModelMetadataSync("openai", "not-in-cache", { home: homeWithStore }),
    ).toBeNull();
    // Wrong provider's cache does not contain the id.
    expect(
      getDiscoveredModelMetadataSync("nvidia", DISCOVERED_ID, { home: homeWithStore }),
    ).toBeNull();
    // A home without any discovery cache reads as "not discovered".
    expect(getDiscoveredModelMetadataSync("openai", DISCOVERED_ID, { home: emptyHome })).toBeNull();
  });

  test("carries the cached entry's capabilities for a discovered vision model", () => {
    const resolved = getDiscoveredModelMetadataSync("openai", DISCOVERED_VISION_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.supportsImageInput).toBe(true);
    expect(resolved?.displayName).toBe("Discovered Vision");
    expect(resolved?.knowledgeCutoff).toBe("January 1, 2025");
    expect(resolved?.source).toBe("dynamic");
  });

  test("keeps reasoning defaults when the cached entry advertises reasoning", () => {
    const resolved = getDiscoveredModelMetadataSync("openai", DISCOVERED_REASONING_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.providerOptionsDefaults.reasoningEffort).toBe("high");
    expect(resolved?.providerOptionsDefaults.reasoningSummary).toBe("detailed");
  });

  test("honors the cached default effort when it differs from the provider fallback", () => {
    // The cache advertises "medium" while the OpenAI fallback default is "high";
    // the resolved defaults must reflect the cached effort so config loading and
    // child routing do not send the fallback-high payload.
    const resolved = getDiscoveredModelMetadataSync("openai", DISCOVERED_REASONING_MEDIUM_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.providerOptionsDefaults.reasoningEffort).toBe("medium");
  });

  test("drops reasoning defaults when the cached entry has no reasoning info", () => {
    const resolved = getDiscoveredModelMetadataSync("openai", DISCOVERED_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.providerOptionsDefaults.reasoningEffort).toBeUndefined();
    expect(resolved?.providerOptionsDefaults.reasoningSummary).toBeUndefined();
    // textVerbosity is GPT-5-family only; a non-GPT-5 discovered id must not
    // carry it either.
    expect(resolved?.providerOptionsDefaults.textVerbosity).toBeUndefined();
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

  test("strict selection prefers discovered metadata over the custom placeholder", async () => {
    // Strict resolution (no allowPlaceholder) for an id in both stores must
    // return the discovered vision entry, not the generic custom placeholder,
    // so model selection does not downgrade it to text-only.
    const resolved = await resolveModelMetadata("openai", DISCOVERED_AND_CUSTOM_VISION_ID, {
      source: "model",
      home: homeWithStore,
    });
    expect(resolved.id).toBe(DISCOVERED_AND_CUSTOM_VISION_ID);
    expect(resolved.supportsImageInput).toBe(true);
    expect(resolved.displayName).toBe("Dup Vision");
    expect(resolved.source).toBe("dynamic");
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

  test("strips reasoning defaults for an unproven custom non-OpenAI id", () => {
    // A custom Anthropic id carries no capability proof, so the placeholder must
    // not inherit the provider default's thinking/effort keys — buildPiStreamOptions
    // would otherwise forward a thinking payload a non-reasoning custom id (e.g. a
    // legacy claude-3-5 deployment) rejects on the first turn.
    const resolved = getKnownResolvedModelMetadata("anthropic", CUSTOM_ONLY_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.providerOptionsDefaults.thinking).toBeUndefined();
    expect(resolved?.providerOptionsDefaults.effort).toBeUndefined();
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

  test("preserves cached vision capability when resuming a discovered model", () => {
    // A reopened session on a cached vision model must keep supportsImageInput:
    // true instead of being downgraded to the generic placeholder's false.
    const resolved = getKnownResolvedModelMetadata("openai", DISCOVERED_VISION_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(DISCOVERED_VISION_ID);
    expect(resolved?.supportsImageInput).toBe(true);
    expect(resolved?.displayName).toBe("Discovered Vision");
    expect(resolved?.knowledgeCutoff).toBe("January 1, 2025");
    expect(resolved?.source).toBe("dynamic");
  });

  test("prefers discovered metadata over the custom placeholder for a dual-store id", () => {
    // The id is in BOTH the custom store and the discovery cache. Resume must
    // seed the richer discovered vision metadata, not the text-only custom
    // placeholder, so it matches what the catalog advertises.
    const resolved = getKnownResolvedModelMetadata("openai", DISCOVERED_AND_CUSTOM_VISION_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(DISCOVERED_AND_CUSTOM_VISION_ID);
    expect(resolved?.supportsImageInput).toBe(true);
    expect(resolved?.displayName).toBe("Dup Vision");
    expect(resolved?.source).toBe("dynamic");
  });

  test("drops reasoning defaults for a custom non-reasoning OpenAI id", () => {
    // A custom gpt-4o (non-reasoning) must not inherit the provider default's
    // reasoning payload, or the first Responses request fails because the
    // runtime fallback model marks reasoning: false.
    const resolved = getKnownResolvedModelMetadata("openai", CUSTOM_OPENAI_NON_REASONING_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(CUSTOM_OPENAI_NON_REASONING_ID);
    expect(resolved?.providerOptionsDefaults.reasoningEffort).toBeUndefined();
    expect(resolved?.providerOptionsDefaults.reasoningSummary).toBeUndefined();
    // textVerbosity is GPT-5-family only, so gpt-4o must not carry it either.
    expect(resolved?.providerOptionsDefaults.textVerbosity).toBeUndefined();
  });

  test("keeps reasoning defaults but drops verbosity for a custom o-series OpenAI id", () => {
    // o3 supports reasoning but NOT verbosity (a GPT-5-family parameter).
    const resolved = getKnownResolvedModelMetadata("openai", CUSTOM_OPENAI_REASONING_ID, {
      home: homeWithStore,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(CUSTOM_OPENAI_REASONING_ID);
    expect(resolved?.providerOptionsDefaults.reasoningEffort).toBe("high");
    expect(resolved?.providerOptionsDefaults.reasoningSummary).toBe("detailed");
    expect(resolved?.providerOptionsDefaults.textVerbosity).toBeUndefined();
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

describe("getResolvedModelMetadataSync with bedrock discovery home", () => {
  test("resolves a discovered bedrock id from the snapshot when opts.home is passed", () => {
    // Before threading opts.home into getKnownBedrockResolvedModelMetadataSync,
    // the bedrock branch read the process home's (empty) snapshot and fell back
    // to a generic placeholder even when the caller passed the session home.
    const resolved = getResolvedModelMetadataSync("bedrock", BEDROCK_DISCOVERED_ID, "model", {
      home: homeWithStore,
    });
    expect(resolved.id).toBe(BEDROCK_DISCOVERED_ID);
    expect(resolved.provider).toBe("bedrock");
    expect(resolved.displayName).toBe("Discovered Bedrock");
    expect(resolved.source).toBe("dynamic");
  });

  test("falls back to a placeholder when the session home lacks the snapshot", () => {
    const resolved = getResolvedModelMetadataSync("bedrock", BEDROCK_DISCOVERED_ID, "model", {
      home: emptyHome,
    });
    expect(resolved.id).toBe(BEDROCK_DISCOVERED_ID);
    // Placeholder metadata uses the id as its display name.
    expect(resolved.displayName).toBe(BEDROCK_DISCOVERED_ID);
  });

  test("consults the discovery cache for a dynamic-provider id so vision is preserved on the first turn", () => {
    // Before the dynamic branch consulted the discovery cache, a model that
    // existed only in the cache (e.g. a discovered vision id) resolved to the
    // generic placeholder with supportsImageInput:false on the first turn,
    // silently downgrading it to text-only even though the cache advertised
    // image input.
    const resolved = getResolvedModelMetadataSync("openai", DISCOVERED_VISION_ID, "model", {
      home: homeWithStore,
    });
    expect(resolved.id).toBe(DISCOVERED_VISION_ID);
    expect(resolved.provider).toBe("openai");
    expect(resolved.supportsImageInput).toBe(true);
    expect(resolved.displayName).toBe("Discovered Vision");
    expect(resolved.source).toBe("dynamic");
  });

  test("still falls back to the placeholder when a dynamic id is absent from the cache", () => {
    const resolved = getResolvedModelMetadataSync("openai", "acme/never-discovered", "model", {
      home: emptyHome,
    });
    expect(resolved.id).toBe("acme/never-discovered");
    expect(resolved.supportsImageInput).toBe(false);
    expect(resolved.displayName).toBe("acme/never-discovered");
  });
});

describe("modelSupportsImageInputSync", () => {
  // The attachment-materialization and `read`-tool image gates route through this
  // helper (not the static-registry-only supportsImageInput), so a discovered
  // vision model advertises image support and its uploads/reads keep visual
  // content instead of being downgraded to path-only text.
  const configFor = (home: string, model: string) => ({
    provider: "openai" as const,
    model,
    skillsDirs: [],
    userCoworkDir: path.join(home, ".cowork"),
  });

  test("returns true for a discovered vision model in the cache", () => {
    expect(modelSupportsImageInputSync(configFor(homeWithStore, DISCOVERED_VISION_ID))).toBe(true);
  });

  test("returns false for a discovered non-vision model", () => {
    expect(modelSupportsImageInputSync(configFor(homeWithStore, DISCOVERED_ID))).toBe(false);
  });

  test("returns false for a dynamic id absent from the cache under an empty home", () => {
    expect(modelSupportsImageInputSync(configFor(emptyHome, DISCOVERED_VISION_ID))).toBe(false);
  });
});

describe("reconcileReasoningProviderOptions", () => {
  test("drops reasoning keys the resolved model does not declare", () => {
    const providerOptions = {
      openai: { reasoningEffort: "high", reasoningSummary: "detailed", textVerbosity: "medium" },
    };
    // gpt-4o placeholder defaults carry no reasoning keys → strip the stale ones.
    const result = reconcileReasoningProviderOptions(providerOptions, "openai", {
      textVerbosity: "medium",
    }) as { openai: Record<string, unknown> };
    expect(result.openai).toEqual({ textVerbosity: "medium" });
    // Original object is not mutated.
    expect(providerOptions.openai.reasoningEffort).toBe("high");
  });

  test("keeps reasoning keys when the resolved model declares them", () => {
    const providerOptions = {
      openai: { reasoningEffort: "xhigh", reasoningSummary: "detailed" },
    };
    const result = reconcileReasoningProviderOptions(providerOptions, "openai", {
      reasoningEffort: "high",
      reasoningSummary: "detailed",
    });
    // Reasoning-capable model → the user's explicit effort survives unchanged.
    expect(result).toBe(providerOptions);
  });

  test("is a no-op for providers without reasoning keys or missing sections", () => {
    const providerOptions = { openai: { reasoningEffort: "high" } };
    // together has no reasoning-key mapping.
    expect(reconcileReasoningProviderOptions(providerOptions, "together", {})).toBe(
      providerOptions,
    );
    // No openai section to reconcile.
    const other = { google: { thinkingConfig: {} } };
    expect(reconcileReasoningProviderOptions(other, "openai", {})).toBe(other);
  });
});
