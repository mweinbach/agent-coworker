import path from "node:path";

import { type AiCoworkerPaths, getAiCoworkerPaths, readConnectionStore } from "../connect";
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
import { resolveAuthHomeDir } from "../utils/authHome";
import { isAntigravitySupportedPlatform } from "./antigravitySupport";
import { BASETEN_BASE_URL, resolveBasetenApiKey } from "./basetenShared";
import { readBedrockCatalogSnapshot } from "./bedrockShared";
import { openAiReasoningConfigForSupportedModel } from "./catalog";
import { type listCodexAppServerModels, readCodexAppServerAccount } from "./codexAppServerAuth";
import { type CustomModelEntry, readCustomModelStore } from "./customModels";
import {
  FIREWORKS_INFERENCE_BASE_URL,
  isFireworksInferenceProvider,
  resolveFireworksInferenceApiKey,
} from "./fireworksShared";
import { lmStudioCatalogStateMessage } from "./lmstudio/catalog";
import { isLmStudioError, resolveLmStudioProviderOptions } from "./lmstudio/client";
import { MINIMAX_BASE_URL, resolveMinimaxApiKey } from "./minimaxShared";
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
  writeModelDiscoveryCache,
} from "./modelDiscoveryCache";
import { readModelPreferencesStore } from "./modelPreferences";
import { NVIDIA_BASE_URL, resolveNvidiaApiKey } from "./nvidiaShared";
import {
  getOpenCodeDisplayName,
  getOpenCodeProviderConfig,
  isOpenCodeProviderName,
  resolveOpenCodeApiKey,
} from "./opencodeShared";
import { resolveTogetherApiKey, TOGETHER_BASE_URL } from "./togetherShared";

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

type ApiModelDiscoveryProvider = Extract<
  ProviderName,
  | "google"
  | "openai"
  | "anthropic"
  | "baseten"
  | "together"
  | "fireworks"
  | "firepass"
  | "nvidia"
  | "minimax"
  | "opencode-go"
  | "opencode-zen"
>;

function resolveOpenAiApiKey(opts: {
  savedKey?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = opts.env ?? process.env;
  return opts.savedKey?.trim() || env.OPENAI_API_KEY?.trim() || undefined;
}

function resolveGoogleApiKey(opts: {
  savedKey?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = opts.env ?? process.env;
  return (
    opts.savedKey?.trim() ||
    env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    env.GEMINI_API_KEY?.trim() ||
    env.GOOGLE_API_KEY?.trim() ||
    undefined
  );
}

function resolveAnthropicApiKey(opts: {
  savedKey?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = opts.env ?? process.env;
  return opts.savedKey?.trim() || env.ANTHROPIC_API_KEY?.trim() || undefined;
}

function isApiModelDiscoveryProvider(
  provider: ProviderName,
): provider is ApiModelDiscoveryProvider {
  return (
    provider === "google" ||
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "baseten" ||
    provider === "together" ||
    provider === "fireworks" ||
    provider === "firepass" ||
    provider === "nvidia" ||
    provider === "minimax" ||
    provider === "opencode-go" ||
    provider === "opencode-zen"
  );
}

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

function discoveryFailureMessage(
  provider: ProviderName,
  error: unknown,
  updatedAt: string,
): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${PROVIDER_LABELS[provider]} model discovery failed: ${reason} Using cached model catalog from ${updatedAt}.`;
}

async function discoverProviderModelsWithCache(opts: {
  paths: AiCoworkerPaths;
  adapter: ModelDiscoveryAdapter;
  forceRefresh?: boolean;
}): Promise<{
  discovery: ModelDiscoveryResult;
  stale: boolean;
  message?: string;
}> {
  const cached = await readModelDiscoveryCache(opts.paths, opts.adapter.provider);
  if (cached && !opts.forceRefresh && isModelDiscoveryCacheFresh(cached)) {
    return { discovery: modelDiscoveryResultFromCache(cached), stale: false };
  }

  try {
    const discovery = await opts.adapter.discover({
      reason: opts.forceRefresh ? "manual" : cached ? "ttl" : "catalog",
      force: opts.forceRefresh || !cached || !isModelDiscoveryCacheFresh(cached),
    });
    if (discovery.source === "static" && cached && cached.source !== "static") {
      return {
        discovery: modelDiscoveryResultFromCache(cached),
        stale: true,
        message:
          discovery.message ??
          `${PROVIDER_LABELS[opts.adapter.provider]} model discovery fell back to static data. Using cached model catalog from ${cached.updatedAt}.`,
      };
    }
    if (discovery.source === "static") {
      return { discovery, stale: false, message: discovery.message };
    }
    if (discovery.models.length === 0 && cached && cached.source !== "static") {
      return {
        discovery: modelDiscoveryResultFromCache(cached),
        stale: true,
        message:
          discovery.message ??
          `${PROVIDER_LABELS[opts.adapter.provider]} model discovery returned no usable models. Using cached model catalog from ${cached.updatedAt}.`,
      };
    }
    const next = await writeModelDiscoveryCache(opts.paths, opts.adapter.provider, discovery);
    return { discovery: modelDiscoveryResultFromCache(next), stale: false };
  } catch (error) {
    if (cached) {
      return {
        discovery: modelDiscoveryResultFromCache(cached),
        stale: true,
        message: discoveryFailureMessage(opts.adapter.provider, error, cached.updatedAt),
      };
    }
    throw error;
  }
}

function staticCatalogEntry(provider: Exclude<ProviderName, "lmstudio">): ProviderCatalogEntry {
  return {
    id: provider,
    name: PROVIDER_LABELS[provider],
    models: listSupportedModels(provider).map(staticCatalogModelEntry),
    defaultModel: defaultSupportedModel(provider).id,
  };
}

function customModelToCatalogEntry(model: CustomModelEntry): ProviderCatalogModelEntry {
  return {
    id: model.id,
    displayName: model.displayName ?? model.id,
    description: "Custom model ID",
    knowledgeCutoff: "Unknown",
    supportsImageInput: false,
    runtimeOptions: { source: "custom" },
  };
}

function mergeCustomModelsIntoCatalogEntry(
  entry: ProviderCatalogEntry,
  customModelsByProvider: Awaited<ReturnType<typeof readCustomModelStore>>["providers"],
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
    .map(customModelToCatalogEntry);
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
  if (opts.provider === "openai") return resolveOpenAiApiKey({ savedKey, env: opts.env });
  if (opts.provider === "google") return resolveGoogleApiKey({ savedKey, env: opts.env });
  if (opts.provider === "anthropic") return resolveAnthropicApiKey({ savedKey, env: opts.env });
  if (opts.provider === "baseten") return resolveBasetenApiKey({ savedKey, env: opts.env });
  if (opts.provider === "together") return resolveTogetherApiKey({ savedKey, env: opts.env });
  if (isFireworksInferenceProvider(opts.provider)) {
    return resolveFireworksInferenceApiKey(opts.provider, { savedKey, env: opts.env });
  }
  if (opts.provider === "nvidia") return resolveNvidiaApiKey({ savedKey, env: opts.env });
  if (opts.provider === "minimax") return resolveMinimaxApiKey({ savedKey, env: opts.env });
  return resolveOpenCodeApiKey(opts.provider, { savedKey, env: opts.env });
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
      adapter: createApiModelDiscoveryAdapter({
        provider: opts.provider,
        apiKey,
        fetchImpl: opts.fetchImpl,
      }),
      forceRefresh: opts.forceRefresh,
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
}): Promise<ProviderCatalogEntry> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
  try {
    const result = await discoverProviderModelsWithCache({
      paths,
      adapter: createCodexAppServerModelDiscoveryAdapter({
        codexHome: opts.codexHome,
        listCodexAppServerModelsImpl: opts.listCodexAppServerModelsImpl,
      }),
      forceRefresh: opts.forceRefresh,
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
}): Promise<{ entry: ProviderCatalogEntry; connected: boolean }> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir ?? resolveAuthHomeDir() });
  const discovery = await discoverProviderModelsWithCache({
    paths,
    adapter: createBedrockModelDiscoveryAdapter({
      paths,
      env: opts.env,
    }),
    forceRefresh: opts.forceRefresh,
  });
  const snapshot = await readBedrockCatalogSnapshot({
    paths,
    env: opts.env,
  });
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
}): Promise<{ entry: ProviderCatalogEntry; connected: boolean }> {
  const provider = resolveLmStudioProviderOptions(opts.providerOptions, opts.env);
  try {
    const paths = opts.paths ?? getAiCoworkerPaths({ homedir: resolveAuthHomeDir() });
    const discovery = await discoverProviderModelsWithCache({
      paths,
      adapter: createLmStudioModelDiscoveryAdapter({
        baseUrl: provider.baseUrl,
        apiKey:
          provider.apiKey ??
          (opts.store ? storedProviderApiKey(opts.store, "lmstudio") : undefined),
        fetchImpl: opts.lmstudioFetchImpl,
      }),
      forceRefresh: opts.forceRefresh,
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

export async function listProviderCatalogEntries(
  opts: {
    homedir?: string;
    paths?: AiCoworkerPaths;
    store?: Awaited<ReturnType<typeof readConnectionStore>>;
    providerOptions?: unknown;
    env?: NodeJS.ProcessEnv;
    lmstudioFetchImpl?: typeof fetch;
    modelDiscoveryFetchImpl?: typeof fetch;
    listCodexAppServerModelsImpl?: typeof listCodexAppServerModels;
    platform?: NodeJS.Platform;
    refresh?: boolean;
  } = {},
): Promise<ProviderCatalogEntry[]> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir ?? resolveAuthHomeDir() });
  const customModelStore = await readCustomModelStore(paths);
  const modelPreferencesStore = await readModelPreferencesStore(paths);
  const bedrock = await bedrockCatalogEntry({
    paths,
    providerOptions: opts.providerOptions,
    env: opts.env,
    forceRefresh: opts.refresh,
  });
  const lmstudio = await lmStudioCatalogEntry({ ...opts, paths, forceRefresh: opts.refresh });
  const codex = opts.listCodexAppServerModelsImpl
    ? await codexCatalogEntry({
        listCodexAppServerModelsImpl: opts.listCodexAppServerModelsImpl,
        paths,
        forceRefresh: opts.refresh,
      })
    : staticCatalogEntry("codex-cli");
  const apiEntries = new Map<ProviderName, ProviderCatalogEntry>();
  const shouldReadApiCatalogs = Boolean(
    opts.paths ||
      opts.homedir ||
      opts.store ||
      opts.env ||
      opts.modelDiscoveryFetchImpl ||
      opts.refresh,
  );
  if (shouldReadApiCatalogs) {
    await Promise.all(
      PROVIDER_NAMES.filter(isApiModelDiscoveryProvider).map(async (provider) => {
        apiEntries.set(
          provider,
          await apiModelCatalogEntry({
            provider,
            store: opts.store,
            env: opts.env,
            paths,
            fetchImpl: opts.modelDiscoveryFetchImpl,
            forceRefresh: opts.refresh,
          }),
        );
      }),
    );
  }
  return PROVIDER_NAMES.filter(
    (provider) => provider !== "antigravity" || isAntigravitySupportedPlatform(opts.platform),
  )
    .map((provider) => {
      if (provider === "bedrock") return bedrock.entry;
      if (provider === "lmstudio") return lmstudio.entry;
      if (provider === "codex-cli") return codex;
      const apiEntry = apiEntries.get(provider);
      if (apiEntry) return apiEntry;
      return staticCatalogEntry(provider);
    })
    .map((entry) => mergeCustomModelsIntoCatalogEntry(entry, customModelStore.providers))
    .map((entry) =>
      applyModelPreferencesToCatalogEntry(
        entry,
        modelPreferencesStore.providers,
        customModelStore.providers,
      ),
    );
}

export async function getProviderCatalog(
  opts: {
    homedir?: string;
    paths?: AiCoworkerPaths;
    readStore?: typeof readConnectionStore;
    readCodexAppServerAccountImpl?: typeof readCodexAppServerAccount;
    listCodexAppServerModelsImpl?: typeof listCodexAppServerModels;
    providerOptions?: unknown;
    env?: NodeJS.ProcessEnv;
    lmstudioFetchImpl?: typeof fetch;
    modelDiscoveryFetchImpl?: typeof fetch;
    platform?: NodeJS.Platform;
    refresh?: boolean;
  } = {},
): Promise<ProviderCatalogPayload> {
  const paths = opts.paths ?? getAiCoworkerPaths({ homedir: opts.homedir ?? resolveAuthHomeDir() });
  const readStore = opts.readStore ?? readConnectionStore;
  const readCodexAppServerAccountImpl =
    opts.readCodexAppServerAccountImpl ?? readCodexAppServerAccount;
  const store = await readStore(paths);
  const customModelStore = await readCustomModelStore(paths);
  const modelPreferencesStore = await readModelPreferencesStore(paths);
  const codexHome = codexHomeFromPaths(paths);
  const bedrock = await bedrockCatalogEntry({
    paths,
    providerOptions: opts.providerOptions,
    env: opts.env,
    forceRefresh: opts.refresh,
  });
  const hasCodexAccount = Boolean(
    await readCodexAppServerAccountImpl({ refreshToken: false, codexHome }).then(
      (result) => result.account,
      () => null,
    ),
  );
  const lmstudio = await lmStudioCatalogEntry({
    store,
    providerOptions: opts.providerOptions,
    env: opts.env,
    lmstudioFetchImpl: opts.lmstudioFetchImpl,
    paths,
    forceRefresh: opts.refresh,
  });
  const codex = hasCodexAccount
    ? await codexCatalogEntry({
        listCodexAppServerModelsImpl: opts.listCodexAppServerModelsImpl,
        codexHome,
        paths,
        forceRefresh: opts.refresh,
      })
    : staticCatalogEntry("codex-cli");
  const apiEntries = new Map<ProviderName, ProviderCatalogEntry>();
  await Promise.all(
    PROVIDER_NAMES.filter(isApiModelDiscoveryProvider).map(async (provider) => {
      apiEntries.set(
        provider,
        await apiModelCatalogEntry({
          provider,
          store,
          env: opts.env,
          paths,
          fetchImpl: opts.modelDiscoveryFetchImpl,
          forceRefresh: opts.refresh,
        }),
      );
    }),
  );
  const all = PROVIDER_NAMES.filter(
    (provider) => provider !== "antigravity" || isAntigravitySupportedPlatform(opts.platform),
  )
    .map((provider) => {
      if (provider === "bedrock") return bedrock.entry;
      if (provider === "lmstudio") return lmstudio.entry;
      if (provider === "codex-cli") return codex;
      const apiEntry = apiEntries.get(provider);
      if (apiEntry) return apiEntry;
      return staticCatalogEntry(provider);
    })
    .map((entry) => mergeCustomModelsIntoCatalogEntry(entry, customModelStore.providers))
    .map((entry) =>
      applyModelPreferencesToCatalogEntry(
        entry,
        modelPreferencesStore.providers,
        customModelStore.providers,
      ),
    );
  const defaults: Record<string, string> = {};
  for (const entry of all) defaults[entry.id] = entry.defaultModel;
  const connected = PROVIDER_NAMES.filter((provider) => {
    if (provider === "lmstudio") {
      return lmstudio.connected;
    }
    if (provider === "bedrock") {
      return bedrock.connected;
    }
    if (
      isApiModelDiscoveryProvider(provider) &&
      resolveApiModelDiscoveryKey({ provider, store, env: opts.env })
    ) {
      return true;
    }
    const entry = store.services[provider];
    if (provider === "antigravity" && !isAntigravitySupportedPlatform(opts.platform)) {
      return false;
    }
    if (entry?.mode === "api_key" || entry?.mode === "oauth") return true;
    return provider === "codex-cli" && hasCodexAccount;
  });
  return { all, default: defaults, connected };
}
