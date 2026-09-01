import fs from "node:fs/promises";
import path from "node:path";

import { type AiCoworkerPaths, getAiCoworkerPaths, readConnectionStore } from "../connect";
import { getResolvedModelMetadataSync } from "../models/metadata";
import {
  defaultSupportedModel,
  getSupportedModel,
  listSupportedModels,
  type SupportedModel,
} from "../models/registry";
import { supportsCustomModelIds } from "../shared/customModels";
import {
  GOOGLE_DYNAMIC_REASONING_EFFORT,
  listGoogleReasoningEffortValuesForModel,
} from "../shared/googleThinking";
import { supportsModelPreferences } from "../shared/modelPreferences";
import type { CatalogReasoningEffort } from "../shared/openaiCompatibleOptions";
import { PROVIDER_NAMES, type ProviderName } from "../types";
import { raceWithAbort, withRequestTimeout } from "../utils/abortSignal";
import { resolveAuthHomeDir } from "../utils/authHome";
import { isAntigravitySupportedPlatform } from "./antigravitySupport";
import {
  type ApiKeyProvider as ApiModelDiscoveryProvider,
  isApiKeyProvider as isApiModelDiscoveryProvider,
  resolveAntigravityApiKey,
  resolveProviderApiKey,
} from "./apiKeyAuth";
import { BASETEN_BASE_URL } from "./basetenShared";
import { readBedrockCatalogSnapshot } from "./bedrockShared";
import { openAiReasoningConfigForSupportedModel } from "./catalog";
import { type listCodexAppServerModels, readCodexAppServerAccount } from "./codexAppServerAuth";
import { type CustomModelEntry, readCustomModelStore } from "./customModels";
import { FIREWORKS_INFERENCE_BASE_URL, isFireworksInferenceProvider } from "./fireworksShared";
import { lmStudioCatalogStateMessage } from "./lmstudio/catalog";
import { isLmStudioError, resolveLmStudioProviderOptions } from "./lmstudio/client";
import { MINIMAX_BASE_URL } from "./minimaxShared";
import {
  createAnthropicModelDiscoveryAdapter,
  createBedrockModelDiscoveryAdapter,
  createCodexAppServerModelDiscoveryAdapter,
  createGoogleModelDiscoveryAdapter,
  createLmStudioModelDiscoveryAdapter,
  createOpenAiCompatibleModelDiscoveryAdapter,
} from "./modelDiscoveryAdapters";
import {
  type CachedModelDiscoveryModel,
  isModelDiscoveryCacheFresh,
  type ModelDiscoveryAdapter,
  type ModelDiscoveryResult,
  modelDiscoveryResultFromCache,
  readModelDiscoveryCache,
} from "./modelDiscoveryCache";
import { discoverProviderModelsWithCache } from "./modelDiscoveryService";
import { readModelPreferencesStore } from "./modelPreferences";
import { NVIDIA_BASE_URL } from "./nvidiaShared";
import {
  getOpenCodeDisplayName,
  getOpenCodeProviderConfig,
  isOpenCodeProviderName,
} from "./opencodeShared";
import { TOGETHER_BASE_URL } from "./togetherShared";

function storedProviderApiKey(
  store: Awaited<ReturnType<typeof readConnectionStore>>,
  provider: ProviderName,
): string | undefined {
  const entry = store.services[provider];
  const apiKey = entry?.mode === "api_key" ? entry.apiKey?.trim() : "";
  return apiKey || undefined;
}

export type ProviderCatalogModelEntry = Pick<
  SupportedModel,
  "id" | "displayName" | "knowledgeCutoff" | "supportsImageInput"
> & {
  model?: string;
  description?: string;
  reasoning?: {
    defaultEffort: CatalogReasoningEffort;
    availableEfforts: CatalogReasoningEffort[];
  };
  runtimeOptions?: Record<string, unknown>;
  runtimeOverrides?: Record<string, unknown>;
  /** Omitted when enabled; `false` hides the model from pickers without blocking explicit use. */
  enabled?: boolean;
};

export type ProviderCatalogEntry = {
  id: ProviderName;
  name: string;
  models: ProviderCatalogModelEntry[];
  defaultModel: string;
  state?: "ready" | "empty" | "unreachable";
  message?: string;
};

export type ProviderCatalogPayload = {
  all: ProviderCatalogEntry[];
  default: Record<string, string>;
  connected: string[];
};

/** Saved configuration and discovery only; never evidence of live connectivity. */
export type ProviderCatalogSnapshot = Omit<ProviderCatalogPayload, "connected"> & {
  source: "cache-only";
  configured: ProviderName[];
};

function codexHomeFromPaths(paths: AiCoworkerPaths): string {
  return path.join(paths.authDir, "codex-cli");
}

const PROVIDER_LABELS: Record<ProviderName, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "Amazon Bedrock",
  baseten: "Baseten",
  together: "Together AI",
  fireworks: "Fireworks AI",
  firepass: "Fire Pass",
  nvidia: "NVIDIA",
  lmstudio: "LM Studio",
  minimax: "MiniMax",
  "opencode-go": getOpenCodeDisplayName("opencode-go"),
  "opencode-zen": getOpenCodeDisplayName("opencode-zen"),
  "codex-cli": "Codex",
  antigravity: "Antigravity",
};

function uniqueCatalogEfforts(values: readonly CatalogReasoningEffort[]): CatalogReasoningEffort[] {
  return [...new Set(values)];
}

function reasoningConfigForModel(
  model: Pick<
    SupportedModel,
    "id" | "provider" | "providerOptionsDefaults" | "supportedReasoningEfforts"
  >,
  opts: { liveEfforts?: readonly CatalogReasoningEffort[] } = {},
): ProviderCatalogModelEntry["reasoning"] {
  if (model.provider === "google") {
    return {
      defaultEffort: GOOGLE_DYNAMIC_REASONING_EFFORT,
      availableEfforts: uniqueCatalogEfforts(listGoogleReasoningEffortValuesForModel(model.id)),
    };
  }

  const openAiConfig = openAiReasoningConfigForSupportedModel(model);
  if (!openAiConfig) return undefined;
  return {
    defaultEffort: openAiConfig.defaultEffort,
    availableEfforts: uniqueCatalogEfforts(opts.liveEfforts ?? openAiConfig.availableEfforts),
  };
}

function reasoningConfigForDiscoveredModel(
  model: CachedModelDiscoveryModel,
  supported?: SupportedModel,
): ProviderCatalogModelEntry["reasoning"] {
  const staticReasoning = supported ? reasoningConfigForModel(supported) : undefined;
  const availableEfforts = uniqueCatalogEfforts(
    model.reasoning?.availableEfforts ?? staticReasoning?.availableEfforts ?? [],
  );
  const defaultEffort =
    model.reasoning?.defaultEffort ??
    staticReasoning?.defaultEffort ??
    (availableEfforts.length > 0 ? availableEfforts[0] : undefined);
  if (!defaultEffort) return undefined;
  const nextAvailableEfforts = availableEfforts.includes(defaultEffort)
    ? availableEfforts
    : uniqueCatalogEfforts([defaultEffort, ...availableEfforts]);
  if (nextAvailableEfforts.length === 0) return undefined;
  return {
    defaultEffort,
    availableEfforts: nextAvailableEfforts,
  };
}

function staticCatalogModelEntry(model: SupportedModel): ProviderCatalogModelEntry {
  const reasoning = reasoningConfigForModel(model);
  return {
    id: model.id,
    displayName: model.displayName,
    knowledgeCutoff: model.knowledgeCutoff,
    supportsImageInput: model.supportsImageInput,
    ...(reasoning ? { reasoning } : {}),
  };
}

function resolveDiscoveredModel(
  provider: ProviderName,
  model: CachedModelDiscoveryModel,
): { id: string; supported?: SupportedModel } {
  const supported =
    (model.model ? getSupportedModel(provider, model.model) : null) ??
    getSupportedModel(provider, model.id);
  return {
    id: supported?.id ?? model.model ?? model.id,
    ...(supported ? { supported } : {}),
  };
}

function discoveredModelToCatalogEntry(
  provider: ProviderName,
  model: CachedModelDiscoveryModel,
): ProviderCatalogModelEntry {
  const live = resolveDiscoveredModel(provider, model);
  const reasoning = reasoningConfigForDiscoveredModel(model, live.supported);
  return {
    id: live.id,
    ...(model.model && model.model !== live.id ? { model: model.model } : {}),
    displayName: model.displayName || live.supported?.displayName || live.id,
    ...(model.description ? { description: model.description } : {}),
    knowledgeCutoff: live.supported?.knowledgeCutoff ?? model.knowledgeCutoff ?? "Unknown",
    supportsImageInput: live.supported?.supportsImageInput ?? model.supportsImageInput ?? false,
    ...(reasoning ? { reasoning } : {}),
    ...(model.runtimeOptions ? { runtimeOptions: model.runtimeOptions } : {}),
    ...(model.runtimeOverrides ? { runtimeOverrides: model.runtimeOverrides } : {}),
  };
}

function discoveredModelsToCatalogEntries(
  provider: ProviderName,
  models: readonly CachedModelDiscoveryModel[],
): ProviderCatalogModelEntry[] {
  const modelsById = new Map<string, ProviderCatalogModelEntry>();
  for (const model of models) {
    const entry = discoveredModelToCatalogEntry(provider, model);
    if (modelsById.has(entry.id)) continue;
    modelsById.set(entry.id, entry);
  }
  return [...modelsById.values()];
}

function defaultModelFromDiscovery(
  provider: ProviderName,
  discoveryModels: readonly CachedModelDiscoveryModel[],
  catalogModels: readonly ProviderCatalogModelEntry[],
): string {
  const defaultFromDiscovery = discoveryModels.find((model) => model.isDefault);
  if (defaultFromDiscovery) {
    return resolveDiscoveredModel(provider, defaultFromDiscovery).id;
  }
  const staticDefault = listSupportedModels(provider).find((model) => model.isDefault)?.id;
  if (staticDefault && catalogModels.some((model) => model.id === staticDefault)) {
    return staticDefault;
  }
  return catalogModels[0]?.id ?? "";
}

function catalogEntryFromDiscovery(opts: {
  provider: ProviderName;
  discovery: ModelDiscoveryResult;
  state?: ProviderCatalogEntry["state"];
  message?: string;
}): ProviderCatalogEntry {
  const models = discoveredModelsToCatalogEntries(opts.provider, opts.discovery.models);
  return {
    id: opts.provider,
    name: PROVIDER_LABELS[opts.provider],
    models,
    defaultModel: defaultModelFromDiscovery(opts.provider, opts.discovery.models, models),
    ...(opts.state ? { state: opts.state } : {}),
    ...(opts.message ? { message: opts.message } : {}),
  };
}

function staticCatalogEntry(provider: ProviderName): ProviderCatalogEntry {
  return {
    id: provider,
    name: PROVIDER_LABELS[provider],
    models: listSupportedModels(provider).map(staticCatalogModelEntry),
    defaultModel: provider === "lmstudio" ? "" : defaultSupportedModel(provider).id,
  };
}

function customModelToCatalogEntry(
  model: CustomModelEntry,
  provider: ProviderName,
  home?: string,
): ProviderCatalogModelEntry {
  // Resolve the custom id through the same placeholder resolution model selection
  // uses, so a custom reasoning id (e.g. `o3-preview-custom` or a `gpt-5...`
  // deployment) advertises a reasoning block. Without it the catalog entry has no
  // reasoning metadata and desktop `reasoningConfigFromCatalog()` — which only
  // falls back to static-registry models — cannot offer an effort selector even
  // though the runtime treats the model as reasoning-capable.
  const resolved = getResolvedModelMetadataSync(
    provider,
    model.id,
    "custom catalog model",
    home ? { home } : {},
  );
  // Derive strictly from the resolved reasoning defaults (keyed by
  // `reasoningEffort` for OpenAI-compatible providers), so a custom id whose
  // reasoning defaults were stripped as unproven does not advertise a selector
  // the runtime would not honor.
  const openAiReasoning = openAiReasoningConfigForSupportedModel({
    providerOptionsDefaults: resolved.providerOptionsDefaults,
    supportedReasoningEfforts: undefined,
  });
  const reasoning = openAiReasoning
    ? {
        defaultEffort: openAiReasoning.defaultEffort,
        availableEfforts: uniqueCatalogEfforts(openAiReasoning.availableEfforts),
      }
    : undefined;
  return {
    id: model.id,
    displayName: model.displayName ?? model.id,
    description: "Custom model ID",
    knowledgeCutoff: "Unknown",
    supportsImageInput: false,
    ...(reasoning ? { reasoning } : {}),
    runtimeOptions: { source: "custom" },
  };
}

function mergeCustomModelsIntoCatalogEntry(
  entry: ProviderCatalogEntry,
  customModelsByProvider: Awaited<ReturnType<typeof readCustomModelStore>>["providers"],
  home?: string,
): ProviderCatalogEntry {
  if (!supportsCustomModelIds(entry.id)) return entry;
  const customModels = customModelsByProvider[entry.id] ?? [];
  if (customModels.length === 0) return entry;
  const customIds = new Set(customModels.map((model) => model.id));
  const existingIds = new Set(entry.models.map((model) => model.id));
  // A custom ID that also exists in the catalog keeps its discovered metadata
  // but is still marked as custom-managed, so clients can surface the store
  // entry for removal instead of leaving it invisible.
  const models = entry.models.map((model) =>
    customIds.has(model.id)
      ? { ...model, runtimeOptions: { ...model.runtimeOptions, source: "custom" } }
      : model,
  );
  const annotated = entry.models.some((model) => customIds.has(model.id));
  const additions = customModels
    .filter((model) => !existingIds.has(model.id))
    .map((model) => customModelToCatalogEntry(model, entry.id, home));
  if (!annotated && additions.length === 0) return entry;
  return {
    ...entry,
    models: [...models, ...additions],
    defaultModel: entry.defaultModel || additions[0]?.id || "",
  };
}

// Cross-provider default-enabled set for open-model aggregator catalogs.
// Matched against the last path segment of the model id (case-insensitive),
// so together's "moonshotai/Kimi-K2.6" and opencode's "kimi-k2.6" both hit.
const CURATED_OPEN_MODEL_DEFAULT_PATTERNS: readonly RegExp[] = [
  /^nemotron-3-ultra(?:$|[-.])/,
  /^minimax-m3(?:$|[-.])/,
  /^glm-5\.2(?:$|[-.])/,
  // Fireworks spells version dots with "p" (kimi-k2p6), so accept both.
  /^kimi-k2[.p]6(?:$|[-.])/,
  /^deepseek-v4-pro(?:$|[-.])/,
  /^deepseek-v4-flash(?:$|[-.])/,
];

const CURATED_OPEN_MODEL_PROVIDERS = new Set<ProviderName>([
  "together",
  "nvidia",
  "minimax",
  "baseten",
  "fireworks",
  "firepass",
  "opencode-go",
  "opencode-zen",
]);

function isCuratedOpenModelDefault(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  const lastSegment = normalized.split("/").pop() ?? normalized;
  return CURATED_OPEN_MODEL_DEFAULT_PATTERNS.some((pattern) => pattern.test(lastSegment));
}

function applyModelPreferencesToCatalogEntry(
  entry: ProviderCatalogEntry,
  preferencesByProvider: Awaited<ReturnType<typeof readModelPreferencesStore>>["providers"],
  customModelsByProvider: Awaited<ReturnType<typeof readCustomModelStore>>["providers"],
): ProviderCatalogEntry {
  if (!supportsModelPreferences(entry.id)) return entry;
  if (entry.models.length === 0) return entry;

  const overrides = new Map(
    (preferencesByProvider[entry.id] ?? []).map((pref) => [pref.id, pref.enabled] as const),
  );
  const customIds = new Set(
    (supportsCustomModelIds(entry.id) ? (customModelsByProvider[entry.id] ?? []) : []).map(
      (model) => model.id,
    ),
  );

  // Codex app-server discovery reflects the user's actual account entitlements,
  // so its models stay enabled by default. Open-model aggregators default to
  // the curated cross-provider list; everything else uses the model registry.
  const discoveryIsAuthoritative = entry.id === "codex-cli";

  // The curated rule only applies when the catalog actually carries at least
  // one of the curated defaults; otherwise the registry rule keeps the
  // provider from going dark.
  const useCuratedOpenDefaults =
    CURATED_OPEN_MODEL_PROVIDERS.has(entry.id) &&
    entry.models.some((model) => isCuratedOpenModelDefault(model.id));

  // The per-model default-enabled decision IGNORING any user overrides. This is
  // what determines whether curation/discovery/custom actually matched the
  // catalog, so it must be computed independently of the overrides map.
  const isDefaultEnabled = (modelId: string): boolean =>
    discoveryIsAuthoritative ||
    (useCuratedOpenDefaults
      ? isCuratedOpenModelDefault(modelId)
      : getSupportedModel(entry.id, modelId) !== null) ||
    customIds.has(modelId);

  // Fail open when curation/discovery/custom match NONE of the discovered
  // models. Without this, disabling a single model records one override, which
  // would otherwise flip every other model to its (all-false) registry default
  // and hide the whole catalog. Under fail-open every model defaults to enabled,
  // so an explicit `{id, enabled: false}` override hides only that one model.
  const failOpen = !entry.models.some((model) => isDefaultEnabled(model.id));

  const enabledById = new Map<string, boolean>();
  for (const model of entry.models) {
    const defaultEnabled = failOpen ? true : isDefaultEnabled(model.id);
    enabledById.set(model.id, overrides.get(model.id) ?? defaultEnabled);
  }

  // With no user preferences the fail-open catalog is unchanged, so return the
  // entry untouched (models keep `enabled: undefined`); an explicit disable-all
  // sticks because those overrides are already folded into `enabledById`.
  if (failOpen && overrides.size === 0) return entry;

  const anyEnabled = [...enabledById.values()].some(Boolean);
  const models = entry.models.map((model) =>
    enabledById.get(model.id) === false ? { ...model, enabled: false } : model,
  );

  let defaultModel = entry.defaultModel;
  if (defaultModel && anyEnabled && enabledById.get(defaultModel) === false) {
    const registryDefaultId = defaultSupportedModel(entry.id).id;
    defaultModel =
      enabledById.get(registryDefaultId) === true
        ? registryDefaultId
        : (models.find((model) => model.enabled !== false)?.id ?? defaultModel);
  }

  return { ...entry, models, defaultModel };
}

function resolveApiModelDiscoveryKey(opts: {
  provider: ApiModelDiscoveryProvider;
  store?: Awaited<ReturnType<typeof readConnectionStore>>;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const savedKey = opts.store ? storedProviderApiKey(opts.store, opts.provider) : undefined;
  return resolveProviderApiKey(opts.provider, { savedKey, env: opts.env });
}

function createApiModelDiscoveryAdapter(opts: {
  provider: ApiModelDiscoveryProvider;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): ModelDiscoveryAdapter {
  if (opts.provider === "google") {
    if (!opts.apiKey) throw new Error("Google API key unavailable for model discovery.");
    return createGoogleModelDiscoveryAdapter({ apiKey: opts.apiKey, fetchImpl: opts.fetchImpl });
  }
  if (opts.provider === "anthropic") {
    if (!opts.apiKey) throw new Error("Anthropic API key unavailable for model discovery.");
    return createAnthropicModelDiscoveryAdapter({
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
    });
  }
  if (opts.provider === "openai") {
    if (!opts.apiKey) throw new Error("OpenAI API key unavailable for model discovery.");
    return createOpenAiCompatibleModelDiscoveryAdapter({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
    });
  }
  if (opts.provider === "baseten") {
    if (!opts.apiKey) throw new Error("Baseten API key unavailable for model discovery.");
    return createOpenAiCompatibleModelDiscoveryAdapter({
      provider: "baseten",
      baseUrl: BASETEN_BASE_URL,
      apiKey: opts.apiKey,
      authorizationPrefix: "Api-Key",
      fetchImpl: opts.fetchImpl,
    });
  }
  if (opts.provider === "together") {
    if (!opts.apiKey) throw new Error("Together API key unavailable for model discovery.");
    return createOpenAiCompatibleModelDiscoveryAdapter({
      provider: "together",
      baseUrl: TOGETHER_BASE_URL,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
    });
  }
  if (isFireworksInferenceProvider(opts.provider)) {
    if (!opts.apiKey) {
      throw new Error(`${PROVIDER_LABELS[opts.provider]} API key unavailable for model discovery.`);
    }
    return createOpenAiCompatibleModelDiscoveryAdapter({
      provider: opts.provider,
      baseUrl: FIREWORKS_INFERENCE_BASE_URL,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
    });
  }
  if (opts.provider === "nvidia") {
    if (!opts.apiKey) throw new Error("NVIDIA API key unavailable for model discovery.");
    return createOpenAiCompatibleModelDiscoveryAdapter({
      provider: "nvidia",
      baseUrl: NVIDIA_BASE_URL,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
    });
  }
  if (opts.provider === "minimax") {
    if (!opts.apiKey) throw new Error("MiniMax API key unavailable for model discovery.");
    return createOpenAiCompatibleModelDiscoveryAdapter({
      provider: "minimax",
      baseUrl: MINIMAX_BASE_URL,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
    });
  }
  const providerConfig = getOpenCodeProviderConfig(opts.provider);
  return createOpenAiCompatibleModelDiscoveryAdapter({
    provider: opts.provider,
    baseUrl: providerConfig.baseUrl,
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
  });
}

function bundledFallbackCatalogEntry(
  provider: ApiModelDiscoveryProvider,
  opts: { state?: ProviderCatalogEntry["state"]; message?: string } = {},
): ProviderCatalogEntry {
  const entry = staticCatalogEntry(provider);
  return {
    ...entry,
    ...(opts.state ? { state: opts.state } : {}),
    ...(opts.message ? { message: opts.message } : {}),
  };
}

async function apiModelCatalogEntry(opts: {
  provider: ApiModelDiscoveryProvider;
  store?: Awaited<ReturnType<typeof readConnectionStore>>;
  env?: NodeJS.ProcessEnv;
  paths: AiCoworkerPaths;
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<ProviderCatalogEntry> {
  const apiKey = resolveApiModelDiscoveryKey({
    provider: opts.provider,
    store: opts.store,
    env: opts.env,
  });
  const cached = await readModelDiscoveryCache(opts.paths, opts.provider);
  const cachedIsFresh = isModelDiscoveryCacheFresh(cached);
  const isPublicCatalog = isOpenCodeProviderName(opts.provider);
  const shouldUseLive =
    Boolean(cached) ||
    (Boolean(apiKey) && opts.forceRefresh === true) ||
    (isPublicCatalog && opts.forceRefresh === true);

  if (!shouldUseLive) {
    return bundledFallbackCatalogEntry(opts.provider);
  }

  if (!apiKey && !isPublicCatalog && cached) {
    return catalogEntryFromDiscovery({
      provider: opts.provider,
      discovery: modelDiscoveryResultFromCache(cached),
      state: !cachedIsFresh || opts.forceRefresh ? "unreachable" : "ready",
      message:
        !cachedIsFresh || opts.forceRefresh
          ? `${PROVIDER_LABELS[opts.provider]} API key unavailable. Using cached model catalog from ${cached.updatedAt}.`
          : undefined,
    });
  }

  try {
    const result = await discoverProviderModelsWithCache({
      paths: opts.paths,
      name: PROVIDER_LABELS[opts.provider],
      adapter: createApiModelDiscoveryAdapter({
        provider: opts.provider,
        apiKey,
        fetchImpl: opts.fetchImpl,
      }),
      forceRefresh: opts.forceRefresh,
      timeoutMs: opts.timeoutMs,
    });
    return catalogEntryFromDiscovery({
      provider: opts.provider,
      discovery: result.discovery,
      state: result.stale ? "unreachable" : result.discovery.models.length > 0 ? "ready" : "empty",
      message:
        result.message ??
        (result.discovery.models.length === 0
          ? `${PROVIDER_LABELS[opts.provider]} model discovery returned no usable generation models.`
          : undefined),
    });
  } catch (error) {
    return bundledFallbackCatalogEntry(opts.provider, {
      state: "unreachable",
      message: `${PROVIDER_LABELS[opts.provider]} model discovery failed: ${
        error instanceof Error ? error.message : String(error)
      }. Showing bundled model catalog.`,
    });
  }
}

async function codexCatalogEntry(opts: {
  listCodexAppServerModelsImpl?: typeof listCodexAppServerModels;
  codexHome?: string;
  paths?: AiCoworkerPaths;
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<ProviderCatalogEntry> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
  try {
    const result = await discoverProviderModelsWithCache({
      paths,
      name: PROVIDER_LABELS["codex-cli"],
      adapter: createCodexAppServerModelDiscoveryAdapter({
        codexHome: opts.codexHome,
        listCodexAppServerModelsImpl: opts.listCodexAppServerModelsImpl,
      }),
      forceRefresh: opts.forceRefresh,
      timeoutMs: opts.timeoutMs,
    });
    const entry = catalogEntryFromDiscovery({
      provider: "codex-cli",
      discovery: result.discovery,
      state: result.stale ? "unreachable" : result.discovery.models.length > 0 ? "ready" : "empty",
      message:
        result.message ??
        (result.discovery.models.length === 0
          ? "Codex app-server did not report any locally supported models."
          : undefined),
    });
    return entry;
  } catch (error) {
    return {
      id: "codex-cli",
      name: PROVIDER_LABELS["codex-cli"],
      models: [],
      defaultModel: "",
      state: "unreachable",
      message: error instanceof Error ? error.message : "Unable to read Codex app-server models.",
    };
  }
}

async function bedrockCatalogEntry(opts: {
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  paths?: AiCoworkerPaths;
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<{ entry: ProviderCatalogEntry; connected: boolean }> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir ?? resolveAuthHomeDir() });
  const snapshot = await readBedrockCatalogSnapshot({
    paths,
    env: opts.env,
  });
  const adapter = createBedrockModelDiscoveryAdapter({ paths, env: opts.env });
  adapter.cache = { scope: JSON.stringify(snapshot.auth) };
  let discovery: Awaited<ReturnType<typeof discoverProviderModelsWithCache>>;
  try {
    discovery = await discoverProviderModelsWithCache({
      paths,
      name: PROVIDER_LABELS.bedrock,
      adapter,
      forceRefresh: opts.forceRefresh,
      timeoutMs: opts.timeoutMs,
    });
  } catch (error) {
    return {
      entry: {
        ...staticCatalogEntry("bedrock"),
        state: "unreachable",
        message: `Bedrock model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      connected: snapshot.connected,
    };
  }
  return {
    entry: catalogEntryFromDiscovery({
      provider: "bedrock",
      discovery: discovery.discovery,
      state: discovery.stale ? "unreachable" : snapshot.state,
      message: discovery.message ?? snapshot.message,
    }),
    connected: snapshot.connected,
  };
}

async function lmStudioCatalogEntry(opts: {
  store?: Awaited<ReturnType<typeof readConnectionStore>>;
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  lmstudioFetchImpl?: typeof fetch;
  paths?: AiCoworkerPaths;
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<{ entry: ProviderCatalogEntry; connected: boolean }> {
  const provider = resolveLmStudioProviderOptions(opts.providerOptions, opts.env);
  try {
    const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
    const discovery = await discoverProviderModelsWithCache({
      paths,
      name: PROVIDER_LABELS.lmstudio,
      adapter: createLmStudioModelDiscoveryAdapter({
        baseUrl: provider.baseUrl,
        apiKey:
          provider.apiKey ??
          (opts.store ? storedProviderApiKey(opts.store, "lmstudio") : undefined),
        fetchImpl: opts.lmstudioFetchImpl,
      }),
      forceRefresh: opts.forceRefresh,
      timeoutMs: opts.timeoutMs,
    });
    const entry = catalogEntryFromDiscovery({
      provider: "lmstudio",
      discovery: discovery.discovery,
      state: discovery.stale
        ? "unreachable"
        : discovery.discovery.models.length > 0
          ? "ready"
          : "empty",
      message:
        discovery.message ??
        (discovery.discovery.models.length === 0
          ? `LM Studio server at ${provider.baseUrl} is reachable, but no LLMs are available.`
          : undefined),
    });
    return {
      entry,
      connected: !discovery.stale,
    };
  } catch (error) {
    if (isLmStudioError(error) && error.code === "no_llms") {
      return {
        entry: {
          id: "lmstudio",
          name: PROVIDER_LABELS.lmstudio,
          models: [],
          defaultModel: "",
          state: "empty",
          message: error.message,
        },
        connected: true,
      };
    }
    return {
      entry: {
        id: "lmstudio",
        name: PROVIDER_LABELS.lmstudio,
        models: [],
        defaultModel: "",
        state: "unreachable",
        message: lmStudioCatalogStateMessage({
          error,
          baseUrl: provider.baseUrl,
        }),
      },
      connected: false,
    };
  }
}

type CatalogOptions = {
  homedir?: string;
  paths?: AiCoworkerPaths;
  providerOptions?: unknown;
  env?: NodeJS.ProcessEnv;
  lmstudioFetchImpl?: typeof fetch;
  modelDiscoveryFetchImpl?: typeof fetch;
  listCodexAppServerModelsImpl?: typeof listCodexAppServerModels;
  platform?: NodeJS.Platform;
  refresh?: boolean;
  discoveryTimeoutMs?: number;
};

function finalizeCatalogEntries(opts: {
  entries: ProviderCatalogEntry[];
  customModels: Awaited<ReturnType<typeof readCustomModelStore>>;
  preferences: Awaited<ReturnType<typeof readModelPreferencesStore>>;
  home: string;
  platform?: NodeJS.Platform;
}): ProviderCatalogEntry[] {
  const entries = new Map(opts.entries.map((entry) => [entry.id, entry]));
  return PROVIDER_NAMES.filter(
    (provider) => provider !== "antigravity" || isAntigravitySupportedPlatform(opts.platform),
  ).map((provider) => {
    const entry = entries.get(provider) ?? staticCatalogEntry(provider);
    return applyModelPreferencesToCatalogEntry(
      mergeCustomModelsIntoCatalogEntry(entry, opts.customModels.providers, opts.home),
      opts.preferences.providers,
      opts.customModels.providers,
    );
  });
}

function hasConfiguredCredentials(
  provider: ProviderName,
  store: Awaited<ReturnType<typeof readConnectionStore>>,
  env: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform | undefined,
): boolean {
  if (provider === "antigravity") {
    if (!isAntigravitySupportedPlatform(platform)) return false;
    if (
      resolveAntigravityApiKey({
        savedKey: storedProviderApiKey(store, "antigravity"),
        googleKey: storedProviderApiKey(store, "google"),
        env,
      })
    )
      return true;
  }
  if (
    isApiModelDiscoveryProvider(provider) &&
    resolveApiModelDiscoveryKey({ provider, store, env })
  ) {
    return true;
  }
  const entry = store.services[provider];
  return entry?.mode === "api_key" || entry?.mode === "oauth";
}

/** Read prompt/model candidates without refreshing providers or starting app servers. */
export async function readProviderCatalogSnapshot(
  opts: Pick<CatalogOptions, "homedir" | "paths" | "providerOptions" | "env" | "platform"> & {
    readStore?: typeof readConnectionStore;
  } = {},
): Promise<ProviderCatalogSnapshot> {
  const home =
    opts.homedir ?? (opts.paths ? path.dirname(opts.paths.rootDir) : resolveAuthHomeDir());
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: home });
  const [store, customModels, preferences, bedrock, hasCodexAuthFile] = await Promise.all([
    (opts.readStore ?? readConnectionStore)(paths),
    readCustomModelStore(paths),
    readModelPreferencesStore(paths),
    readBedrockCatalogSnapshot({ paths, env: opts.env }),
    fs.stat(path.join(codexHomeFromPaths(paths), "auth.json")).then(
      (stat) => stat.isFile(),
      () => false,
    ),
  ]);
  const local = resolveLmStudioProviderOptions(opts.providerOptions, opts.env);
  const localKey = local.apiKey ?? storedProviderApiKey(store, "lmstudio");
  const localScope = createLmStudioModelDiscoveryAdapter({
    baseUrl: local.baseUrl,
    apiKey: localKey,
  }).cache?.scope;
  const cachedEntries = await Promise.all(
    PROVIDER_NAMES.map(async (provider) => {
      const scope =
        provider === "lmstudio"
          ? localScope
          : provider === "bedrock"
            ? JSON.stringify(bedrock.auth)
            : undefined;
      const cached = await readModelDiscoveryCache(paths, provider, scope);
      if (cached) {
        return catalogEntryFromDiscovery({
          provider,
          discovery: modelDiscoveryResultFromCache(cached),
        });
      }
      if (provider === "bedrock") {
        return {
          id: provider,
          name: PROVIDER_LABELS[provider],
          models: bedrock.models,
          defaultModel: bedrock.defaultModel,
        };
      }
      return staticCatalogEntry(provider);
    }),
  );
  const all = finalizeCatalogEntries({
    entries: cachedEntries,
    customModels,
    preferences,
    home,
    platform: opts.platform,
  });
  const configured = all
    .map((entry) => entry.id)
    .filter((provider) => {
      if (provider === "lmstudio") {
        return (
          Boolean(localKey) || (all.find((entry) => entry.id === provider)?.models.length ?? 0) > 0
        );
      }
      if (provider === "bedrock") return bedrock.auth !== null;
      if (provider === "codex-cli" && hasCodexAuthFile) return true;
      return hasConfiguredCredentials(provider, store, opts.env, opts.platform);
    });
  return {
    source: "cache-only",
    all,
    default: Object.fromEntries(all.map((entry) => [entry.id, entry.defaultModel])),
    configured,
  };
}

async function apiCatalogEntries(
  opts: CatalogOptions,
  paths: AiCoworkerPaths,
  store?: Awaited<ReturnType<typeof readConnectionStore>>,
): Promise<ProviderCatalogEntry[]> {
  return await Promise.all(
    PROVIDER_NAMES.filter(isApiModelDiscoveryProvider).map((provider) =>
      apiModelCatalogEntry({
        provider,
        store,
        env: opts.env,
        paths,
        fetchImpl: opts.modelDiscoveryFetchImpl,
        forceRefresh: opts.refresh,
        timeoutMs: opts.discoveryTimeoutMs,
      }),
    ),
  );
}

export async function listProviderCatalogEntries(
  opts: CatalogOptions & { store?: Awaited<ReturnType<typeof readConnectionStore>> } = {},
): Promise<ProviderCatalogEntry[]> {
  const home = opts.homedir ?? resolveAuthHomeDir();
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: home });
  const shouldReadApiCatalogs = Boolean(
    opts.paths ||
      opts.homedir ||
      opts.store ||
      opts.env ||
      opts.modelDiscoveryFetchImpl ||
      opts.refresh,
  );
  const [customModels, preferences, bedrock, lmstudio, codex, apiEntries] = await Promise.all([
    readCustomModelStore(paths),
    readModelPreferencesStore(paths),
    bedrockCatalogEntry({
      ...opts,
      paths,
      forceRefresh: opts.refresh,
      timeoutMs: opts.discoveryTimeoutMs,
    }),
    lmStudioCatalogEntry({
      ...opts,
      paths,
      forceRefresh: opts.refresh,
      timeoutMs: opts.discoveryTimeoutMs,
    }),
    opts.listCodexAppServerModelsImpl
      ? codexCatalogEntry({
          listCodexAppServerModelsImpl: opts.listCodexAppServerModelsImpl,
          paths,
          forceRefresh: opts.refresh,
          timeoutMs: opts.discoveryTimeoutMs,
        })
      : staticCatalogEntry("codex-cli"),
    shouldReadApiCatalogs ? apiCatalogEntries(opts, paths, opts.store) : [],
  ]);
  return finalizeCatalogEntries({
    entries: [bedrock.entry, lmstudio.entry, codex, ...apiEntries],
    customModels,
    preferences,
    home,
    platform: opts.platform,
  });
}

export async function getProviderCatalog(
  opts: CatalogOptions & {
    readStore?: typeof readConnectionStore;
    readCodexAppServerAccountImpl?: typeof readCodexAppServerAccount;
  } = {},
): Promise<ProviderCatalogPayload> {
  const home = opts.homedir ?? resolveAuthHomeDir();
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: home });
  const readStore = opts.readStore ?? readConnectionStore;
  const readCodexAppServerAccountImpl =
    opts.readCodexAppServerAccountImpl ?? readCodexAppServerAccount;
  const [store, customModels, preferences] = await Promise.all([
    readStore(paths),
    readCustomModelStore(paths),
    readModelPreferencesStore(paths),
  ]);
  const codexHome = codexHomeFromPaths(paths);
  const [bedrock, lmstudio, codexResult, apiEntries] = await Promise.all([
    bedrockCatalogEntry({
      ...opts,
      paths,
      forceRefresh: opts.refresh,
      timeoutMs: opts.discoveryTimeoutMs,
    }),
    lmStudioCatalogEntry({
      ...opts,
      store,
      paths,
      forceRefresh: opts.refresh,
      timeoutMs: opts.discoveryTimeoutMs,
    }),
    (async () => {
      const hasAccount = Boolean(
        await raceWithAbort(
          readCodexAppServerAccountImpl({
            refreshToken: opts.refresh === true,
            codexHome,
          }),
          withRequestTimeout(undefined, opts.discoveryTimeoutMs ?? 10_000),
          "Codex account lookup timed out.",
        ).then(
          (result) => result.account,
          () => null,
        ),
      );
      const entry = hasAccount
        ? await codexCatalogEntry({
            listCodexAppServerModelsImpl: opts.listCodexAppServerModelsImpl,
            codexHome,
            paths,
            forceRefresh: opts.refresh,
            timeoutMs: opts.discoveryTimeoutMs,
          })
        : staticCatalogEntry("codex-cli");
      return { entry, hasAccount };
    })(),
    apiCatalogEntries(opts, paths, store),
  ]);
  const all = finalizeCatalogEntries({
    entries: [bedrock.entry, lmstudio.entry, codexResult.entry, ...apiEntries],
    customModels,
    preferences,
    home,
    platform: opts.platform,
  });
  const defaults: Record<string, string> = {};
  for (const entry of all) defaults[entry.id] = entry.defaultModel;
  const connected = PROVIDER_NAMES.filter((provider) => {
    if (provider === "lmstudio") {
      return lmstudio.connected;
    }
    if (provider === "bedrock") {
      return bedrock.connected;
    }
    return (
      hasConfiguredCredentials(provider, store, opts.env, opts.platform) ||
      (provider === "codex-cli" && codexResult.hasAccount)
    );
  });
  return { all, default: defaults, connected };
}
