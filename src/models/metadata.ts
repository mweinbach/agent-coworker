import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildBedrockPlaceholderMetadata,
  getKnownBedrockResolvedModelMetadataSync,
  resolveBedrockModelMetadata,
  resolveDefaultBedrockModelMetadata,
} from "../providers/bedrockShared";
import { readCustomModelStore } from "../providers/customModels";
import { isLmStudioError } from "../providers/lmstudio/client";
import {
  buildLmStudioPlaceholderMetadata,
  resolveDefaultLmStudioModelMetadata,
  resolveLmStudioDiscoveredModelMetadata,
} from "../providers/lmstudio/catalog";
import type { CachedModelDiscoveryModel } from "../providers/modelDiscoveryCache";
import {
  readModelDiscoveryCache,
  readModelDiscoveryCacheSync,
} from "../providers/modelDiscoveryCache";
import { supportsCustomModelIds } from "../shared/customModels";
import { isOpenAiReasoningEffort } from "../shared/openaiCompatibleOptions";
import { getAiCoworkerPaths } from "../store/connections";
import type { AgentConfig, ProviderName } from "../types";
import { resolveAuthHomeDir } from "../utils/authHome";
import type { ResolvedModelMetadata } from "./metadataTypes";
import {
  assertSupportedModel,
  defaultSupportedModel,
  getSupportedModel,
  isModelIdForeignToProvider,
} from "./registry";

type DynamicModelProvider =
  | "lmstudio"
  | "bedrock"
  | "codex-cli"
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
  | "antigravity";

function toResolvedStaticModel(
  provider: ProviderName,
  modelId: string,
  source = "model",
): ResolvedModelMetadata {
  const model = assertSupportedModel(provider, modelId, source);
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.displayName,
    knowledgeCutoff: model.knowledgeCutoff,
    supportsImageInput: model.supportsImageInput,
    promptTemplate: model.promptTemplate,
    providerOptionsDefaults: { ...model.providerOptionsDefaults },
    source: "static",
  };
}

/**
 * Provider-default `providerOptionsDefaults` keys that make a runtime emit a
 * reasoning/thinking payload. A placeholder for a custom id that does not
 * support reasoning must not inherit these, or the very first request sends a
 * reasoning payload the runtime's own fallback model rejects (e.g. a custom
 * OpenAI `gpt-4o` whose Responses fallback marks `reasoning: false`).
 */
const REASONING_PROVIDER_OPTION_KEYS: Record<string, readonly string[]> = {
  openai: ["reasoningEffort", "reasoningSummary"],
  google: ["thinkingConfig"],
  anthropic: ["thinking", "effort"],
};

// GPT-5-family-only provider option keys. Verbosity is documented as a GPT-5
// parameter, so unlike reasoning (which the o-series also supports) it must be
// dropped for any non-GPT-5 OpenAI id, or the Responses runtime sends a
// `text: { verbosity }` payload the model rejects.
const GPT5_FAMILY_ONLY_PROVIDER_OPTION_KEYS: Record<string, readonly string[]> = {
  openai: ["textVerbosity"],
};

// The union of model-gated keys: any of these carried over from a prior model
// is dropped when the newly-resolved model's defaults do not declare it.
const MODEL_GATED_PROVIDER_OPTION_KEYS: Record<string, readonly string[]> = {
  openai: ["reasoningEffort", "reasoningSummary", "textVerbosity"],
  google: ["thinkingConfig"],
  anthropic: ["thinking", "effort"],
};

/**
 * Mirrors the runtime reasoning heuristics (e.g. the OpenAI Responses fallback
 * model in `openaiResponsesModel.ts`): a custom id is only assumed to support
 * reasoning when its name matches a known reasoning family. Providers without a
 * heuristic conservatively keep their defaults.
 */
function customModelIdLikelySupportsReasoning(
  provider: Exclude<DynamicModelProvider, "lmstudio" | "bedrock">,
  modelId: string,
): boolean {
  if (provider === "openai") {
    const id = modelId.trim().toLowerCase();
    return id.startsWith("o") || id.startsWith("gpt-5");
  }
  // Other providers have no cheap id-only heuristic, and a custom id carries no
  // capability proof. Default to NOT reasoning: keeping the provider default's
  // thinking keys (e.g. Anthropic `thinking`/`effort`) would make
  // buildPiStreamOptions forward a thinking payload that a non-reasoning custom
  // id (e.g. a legacy `claude-3-5-...` deployment) rejects on the very first
  // turn — a hard failure. A reasoning custom model instead loses only its
  // DEFAULT effort, which the user can re-enable — a soft, recoverable
  // degradation. Static/discovered models that actually advertise reasoning pass
  // `supportsReasoning: true` explicitly and are unaffected by this heuristic.
  return false;
}

// Verbosity is GPT-5-family only, so an o-series id (which supports reasoning)
// still must not carry it.
function customModelIdLikelySupportsGpt5Params(
  provider: Exclude<DynamicModelProvider, "lmstudio" | "bedrock">,
  modelId: string,
): boolean {
  if (provider === "openai") {
    return modelId.trim().toLowerCase().startsWith("gpt-5");
  }
  return true;
}

function stripProviderOptionKeys(
  defaults: Record<string, unknown>,
  keys: readonly string[] | undefined,
): Record<string, unknown> {
  if (!keys) return defaults;
  const next = { ...defaults };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop reasoning provider options that linger from a previously-selected model
 * when the newly-resolved model does not declare them in its defaults.
 *
 * `prepareModelSelection` spreads the prior config's `providerOptions` into the
 * new config, so switching a live thread from a reasoning model (e.g. GPT-5,
 * whose `reasoningEffort`/`reasoningSummary` are set) to a non-reasoning custom
 * id (e.g. `gpt-4o`) would otherwise forward those stale keys and make the
 * first OpenAI Responses request send a reasoning payload the model rejects.
 * A reasoning-capable model keeps the key (present in its resolved defaults),
 * so a user's explicit effort survives the switch.
 */
export function reconcileReasoningProviderOptions(
  providerOptions: unknown,
  provider: ProviderName,
  resolvedProviderOptionDefaults: Record<string, unknown>,
): unknown {
  const keys = MODEL_GATED_PROVIDER_OPTION_KEYS[provider];
  if (!keys || !isPlainRecord(providerOptions)) return providerOptions;
  const section = providerOptions[provider];
  if (!isPlainRecord(section)) return providerOptions;
  let changed = false;
  const nextSection = { ...section };
  for (const key of keys) {
    if (key in nextSection && !(key in resolvedProviderOptionDefaults)) {
      delete nextSection[key];
      changed = true;
    }
  }
  if (!changed) return providerOptions;
  return { ...providerOptions, [provider]: nextSection };
}

function buildProviderPlaceholderMetadata(
  provider: Exclude<DynamicModelProvider, "lmstudio" | "bedrock">,
  modelId: string,
  opts: { supportsReasoning?: boolean } = {},
): ResolvedModelMetadata {
  const fallback = defaultSupportedModel(provider);
  // Default to the id heuristic; discovered models pass an explicit decision
  // derived from the cache's reasoning info instead.
  const supportsReasoning =
    opts.supportsReasoning ?? customModelIdLikelySupportsReasoning(provider, modelId);
  let providerOptionsDefaults: Record<string, unknown> = { ...fallback.providerOptionsDefaults };
  if (!supportsReasoning) {
    providerOptionsDefaults = stripProviderOptionKeys(
      providerOptionsDefaults,
      REASONING_PROVIDER_OPTION_KEYS[provider],
    );
  }
  if (!customModelIdLikelySupportsGpt5Params(provider, modelId)) {
    providerOptionsDefaults = stripProviderOptionKeys(
      providerOptionsDefaults,
      GPT5_FAMILY_ONLY_PROVIDER_OPTION_KEYS[provider],
    );
  }
  return {
    id: modelId,
    provider,
    displayName: modelId,
    knowledgeCutoff: "Unknown",
    supportsImageInput: false,
    promptTemplate: fallback.promptTemplate,
    providerOptionsDefaults,
    source: "dynamic",
  };
}

/**
 * Builds resolved metadata for a model previously discovered from a provider's
 * live catalog, carrying the cached entry's real capabilities (image input,
 * display name, knowledge cutoff, reasoning) instead of the generic placeholder.
 * A reopened session on a cached vision model must not be downgraded to
 * `supportsImageInput: false`.
 */
function buildDiscoveredModelMetadata(
  provider: Exclude<DynamicModelProvider, "lmstudio" | "bedrock">,
  cached: CachedModelDiscoveryModel,
): ResolvedModelMetadata {
  // The cache's reasoning info is the authoritative signal for discovered
  // models: an entry that advertises a default/available effort supports
  // reasoning; one without any reasoning info does not, so its placeholder must
  // not inherit the provider default's reasoning payload (finding 3 overlap).
  const cacheHasReasoning =
    !!cached.reasoning &&
    (cached.reasoning.defaultEffort !== undefined ||
      (cached.reasoning.availableEfforts?.length ?? 0) > 0);
  const base = buildProviderPlaceholderMetadata(provider, cached.id, {
    supportsReasoning: cacheHasReasoning,
  });
  // When the cache advertises a specific default effort, honor it in the resolved
  // defaults instead of the provider fallback (e.g. OpenAI `reasoningEffort:
  // "high"`). Config loading and child routing consume `providerOptionsDefaults`,
  // so without this a reopened/routed discovered model would send the fallback
  // effort even though the catalog advertised another — potentially an
  // unsupported/too-high reasoning payload. Only OpenAI-compatible providers key
  // reasoning by `reasoningEffort`; anthropic/google use their own keys and are
  // not populated with a generic effort from the discovery cache.
  const cachedDefaultEffort = cached.reasoning?.defaultEffort;
  const providerOptionsDefaults =
    isOpenAiReasoningEffort(cachedDefaultEffort) &&
    "reasoningEffort" in base.providerOptionsDefaults
      ? { ...base.providerOptionsDefaults, reasoningEffort: cachedDefaultEffort }
      : base.providerOptionsDefaults;
  return {
    ...base,
    providerOptionsDefaults,
    displayName: cached.displayName || cached.id,
    ...(cached.knowledgeCutoff ? { knowledgeCutoff: cached.knowledgeCutoff } : {}),
    ...(typeof cached.supportsImageInput === "boolean"
      ? { supportsImageInput: cached.supportsImageInput }
      : {}),
  };
}

export function isDynamicModelProvider(provider: ProviderName): provider is DynamicModelProvider {
  return (
    provider === "lmstudio" ||
    provider === "bedrock" ||
    provider === "codex-cli" ||
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
    provider === "opencode-zen" ||
    provider === "antigravity"
  );
}

/**
 * Providers whose model catalogs are resolved entirely at runtime (local
 * discovery or an external tool), so unknown model ids are always passthrough.
 */
export function isRuntimeDiscoveryProvider(
  provider: ProviderName,
): provider is "lmstudio" | "bedrock" | "codex-cli" {
  return provider === "lmstudio" || provider === "bedrock" || provider === "codex-cli";
}

const CUSTOM_MODEL_STORE_FILENAME = "custom-models.json";

/**
 * Synchronous membership check against the global custom-model store
 * (`~/.cowork/config/custom-models.json`). Sync resolution paths (persisted
 * session resume, model-id normalization) cannot await the async store
 * reader, but must still accept model ids the user explicitly configured.
 * Read-only and tolerant: any missing/invalid store reads as "not configured".
 */
export function isConfiguredCustomModelIdSync(
  provider: ProviderName,
  modelId: string,
  opts: { home?: string } = {},
): boolean {
  if (!supportsCustomModelIds(provider)) return false;
  const trimmed = modelId.trim();
  if (!trimmed) return false;
  try {
    const paths = getAiCoworkerPaths(opts.home ? { homedir: opts.home } : {});
    const raw = readFileSync(path.join(paths.configDir, CUSTOM_MODEL_STORE_FILENAME), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return false;
    const providers = (parsed as { providers?: unknown }).providers;
    if (typeof providers !== "object" || providers === null) return false;
    const entries = (providers as Record<string, unknown>)[provider];
    if (!Array.isArray(entries)) return false;
    return entries.some((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const id = (entry as { id?: unknown }).id;
      return typeof id === "string" && id.trim() === trimmed;
    });
  } catch {
    return false;
  }
}

export function normalizeModelIdForProvider(
  provider: ProviderName,
  modelId: string,
  source = "model",
  opts: { home?: string } = {},
): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error(`${source} is required.`);
  }
  if (provider === "lmstudio" || provider === "bedrock") {
    return trimmed;
  }
  if (isDynamicModelProvider(provider)) {
    const supported = getSupportedModel(provider, trimmed);
    if (supported) return supported.id;
    // Unknown ids pass through for dynamic model discovery, but ids that
    // provably belong to a different provider are rejected with guidance —
    // unless the user explicitly configured the id as a custom model for
    // this provider (the same id can be served by multiple providers).
    if (isModelIdForeignToProvider(provider, trimmed)) {
      if (isConfiguredCustomModelIdSync(provider, trimmed, opts)) {
        return trimmed;
      }
      return assertSupportedModel(provider, trimmed, source).id;
    }
    return trimmed;
  }
  return assertSupportedModel(provider, trimmed, source).id;
}

export function getResolvedModelMetadataSync(
  provider: ProviderName,
  modelId: string,
  source = "model",
  opts: { home?: string } = {},
): ResolvedModelMetadata {
  if (provider === "lmstudio") {
    return buildLmStudioPlaceholderMetadata(
      normalizeModelIdForProvider(provider, modelId, source, opts),
    );
  }
  if (provider === "bedrock") {
    return (
      getKnownBedrockResolvedModelMetadataSync({
        modelId: normalizeModelIdForProvider(provider, modelId, source, opts),
        // Forward the session's auth home so a Bedrock model in the discovery
        // snapshot under a non-default home resolves with its cached metadata
        // instead of falling back to a placeholder (mirrors the sync resume
        // path in getKnownResolvedModelMetadata).
        ...(opts.home ? { home: opts.home } : {}),
      }) ??
      buildBedrockPlaceholderMetadata(normalizeModelIdForProvider(provider, modelId, source, opts))
    );
  }
  if (provider === "codex-cli") {
    const supported = getSupportedModel(provider, modelId);
    if (supported) {
      return {
        id: supported.id,
        provider: supported.provider,
        displayName: supported.displayName,
        knowledgeCutoff: supported.knowledgeCutoff,
        supportsImageInput: supported.supportsImageInput,
        promptTemplate: supported.promptTemplate,
        providerOptionsDefaults: { ...supported.providerOptionsDefaults },
        source: "static",
      };
    }
    return buildProviderPlaceholderMetadata(
      provider,
      normalizeModelIdForProvider(provider, modelId, source, opts),
    );
  }
  if (isDynamicModelProvider(provider)) {
    const supported = getSupportedModel(provider, modelId);
    if (supported) {
      return {
        id: supported.id,
        provider: supported.provider,
        displayName: supported.displayName,
        knowledgeCutoff: supported.knowledgeCutoff,
        supportsImageInput: supported.supportsImageInput,
        promptTemplate: supported.promptTemplate,
        providerOptionsDefaults: { ...supported.providerOptionsDefaults },
        source: "static",
      };
    }
    // A non-static id may still exist in the provider's discovery cache with its
    // real capabilities (vision, reasoning). Consult it before falling back to a
    // generic placeholder so the first turn does not silently drop image input
    // or reasoning — mirrors the resume path in getKnownResolvedModelMetadata.
    // lmstudio/bedrock/codex-cli are handled in earlier branches, so `provider`
    // narrows to the type getDiscoveredModelMetadataSync accepts.
    const discovered = getDiscoveredModelMetadataSync(provider, modelId, opts);
    if (discovered) return discovered;
    return buildProviderPlaceholderMetadata(
      provider,
      normalizeModelIdForProvider(provider, modelId, source, opts),
    );
  }
  return toResolvedStaticModel(provider, modelId, source);
}

/**
 * True when the config's model accepts image input, resolved through the same
 * dynamic metadata the catalog and runtime use (static registry → discovery
 * cache → custom store) rather than the static-only `supportsImageInput`
 * registry lookup. This keeps image-upload materialization and the `read` tool's
 * visual-content gate aligned with a discovered vision model's real capability
 * instead of downgrading a cache-only model to text-only. Threads the session's
 * auth home so the discovery cache resolves under a non-default homedir.
 */
export function modelSupportsImageInputSync(
  config: Pick<AgentConfig, "provider" | "model" | "skillsDirs"> &
    Partial<Pick<AgentConfig, "userCoworkDir">>,
): boolean {
  return getResolvedModelMetadataSync(config.provider, config.model, "image input gate", {
    home: resolveAuthHomeDir(config),
  }).supportsImageInput;
}

/**
 * Metadata for a model previously discovered from the provider's live catalog
 * (persisted under `~/.cowork/cache/models/<provider>.json`), carrying the
 * cached entry's real capabilities. Returns null when the id is not present in
 * the discovery cache.
 */
export async function getDiscoveredModelMetadata(
  provider: Exclude<DynamicModelProvider, "lmstudio" | "bedrock">,
  modelId: string,
  opts: { home?: string } = {},
): Promise<ResolvedModelMetadata | null> {
  try {
    const paths = getAiCoworkerPaths(opts.home ? { homedir: opts.home } : {});
    const cached = await readModelDiscoveryCache(paths, provider);
    if (!cached) return null;
    const match = cached.models.find((model) => model.id === modelId || model.model === modelId);
    if (!match) return null;
    return buildDiscoveredModelMetadata(provider, match);
  } catch {
    return null;
  }
}

/**
 * Synchronous counterpart to {@link getDiscoveredModelMetadata}. Mirrors
 * {@link isConfiguredCustomModelIdSync}: sync resume paths must accept ids the
 * user selected after they were discovered from the provider's live catalog,
 * even though they are absent from the static registry and the custom store,
 * and must carry the cached entry's real capabilities rather than a generic
 * placeholder. Read-only and tolerant: any missing/invalid cache reads as null.
 */
export function getDiscoveredModelMetadataSync(
  provider: Exclude<DynamicModelProvider, "lmstudio" | "bedrock">,
  modelId: string,
  opts: { home?: string } = {},
): ResolvedModelMetadata | null {
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  try {
    const paths = getAiCoworkerPaths(opts.home ? { homedir: opts.home } : {});
    const cached = readModelDiscoveryCacheSync(paths, provider);
    if (!cached) return null;
    const match = cached.models.find((model) => model.id === trimmed || model.model === trimmed);
    if (!match) return null;
    return buildDiscoveredModelMetadata(provider, match);
  } catch {
    return null;
  }
}

export async function getCustomModelMetadata(
  provider: Exclude<DynamicModelProvider, "lmstudio" | "bedrock" | "codex-cli">,
  modelId: string,
  opts: { home?: string } = {},
): Promise<ResolvedModelMetadata | null> {
  if (!supportsCustomModelIds(provider)) return null;
  try {
    const paths = getAiCoworkerPaths(opts.home ? { homedir: opts.home } : {});
    const store = await readCustomModelStore(paths);
    const match = store.providers[provider]?.find((model) => model.id === modelId);
    if (!match) return null;
    return buildProviderPlaceholderMetadata(provider, modelId);
  } catch {
    return null;
  }
}

export async function resolveModelMetadata(
  provider: ProviderName,
  modelId: string,
  opts: {
    allowPlaceholder?: boolean;
    providerOptions?: unknown;
    env?: NodeJS.ProcessEnv;
    home?: string;
    fetchImpl?: typeof fetch;
    source?: string;
    log?: (line: string) => void;
  } = {},
): Promise<ResolvedModelMetadata> {
  const homeOpts = opts.home ? { home: opts.home } : {};
  if (provider === "codex-cli") {
    // codex-cli is not custom-capable, but thread the home harmlessly for
    // consistency with the other sync resolution paths below.
    return getResolvedModelMetadataSync(provider, modelId, opts.source, homeOpts);
  }

  if (provider !== "lmstudio" && provider !== "bedrock") {
    const trimmed = modelId.trim();
    if (
      trimmed &&
      isDynamicModelProvider(provider) &&
      !opts.allowPlaceholder &&
      !getSupportedModel(provider, trimmed)
    ) {
      // Strict resolution (model selection paths): unknown ids are only
      // accepted when configured by the user or previously discovered from the
      // provider. Prefer the discovered cache entry over the custom placeholder:
      // when an id is in both stores the catalog keeps the discovered metadata
      // (real display/capability/reasoning), so selection must not seed the
      // session from a generic text-only/non-reasoning custom placeholder.
      const discovered = await getDiscoveredModelMetadata(provider, trimmed, homeOpts);
      if (discovered) return discovered;
      const custom = await getCustomModelMetadata(provider, trimmed, homeOpts);
      if (custom) return custom;
      return toResolvedStaticModel(provider, trimmed, opts.source);
    }
    // Placeholder-tolerant resolution (prompt loading before every turn):
    // thread the session home so a configured custom cross-registry id is
    // accepted by the sync normalizer's custom-store lookup instead of
    // aborting the turn before the runtime fallback runs.
    return getResolvedModelMetadataSync(provider, modelId, opts.source, homeOpts);
  }

  const normalizedModelId = normalizeModelIdForProvider(provider, modelId, opts.source);
  if (provider === "bedrock") {
    return await resolveBedrockModelMetadata({
      modelId: normalizedModelId,
      home: opts.home,
      env: opts.env,
    });
  }
  try {
    const resolved = await resolveLmStudioDiscoveredModelMetadata({
      modelId: normalizedModelId,
      providerOptions: opts.providerOptions,
      env: opts.env,
      fetchImpl: opts.fetchImpl,
    });
    clearLmStudioPlaceholderWarnings(normalizedModelId);
    return resolved;
  } catch (error) {
    if (opts.allowPlaceholder) {
      // Prompt loading resolves metadata on every turn, so an offline LM Studio
      // would repeat this warning endlessly; log once per server+model until
      // the model resolves successfully again.
      const warningKey = `${isLmStudioError(error) ? error.baseUrl : "unknown"}::${normalizedModelId}`;
      if (!lmStudioPlaceholderWarningKeys.has(warningKey)) {
        lmStudioPlaceholderWarningKeys.add(warningKey);
        opts.log?.(
          `[lmstudio] using conservative placeholder metadata for ${normalizedModelId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return buildLmStudioPlaceholderMetadata(normalizedModelId);
    }
    throw error;
  }
}

const lmStudioPlaceholderWarningKeys = new Set<string>();

function clearLmStudioPlaceholderWarnings(normalizedModelId: string): void {
  for (const key of lmStudioPlaceholderWarningKeys) {
    if (key.endsWith(`::${normalizedModelId}`)) {
      lmStudioPlaceholderWarningKeys.delete(key);
    }
  }
}

export function resetLmStudioPlaceholderWarningCacheForTests(): void {
  lmStudioPlaceholderWarningKeys.clear();
}

export async function resolveDefaultModelMetadata(
  provider: ProviderName,
  opts: {
    providerOptions?: unknown;
    env?: NodeJS.ProcessEnv;
    home?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ResolvedModelMetadata> {
  if (provider === "lmstudio") {
    return await resolveDefaultLmStudioModelMetadata(opts);
  }
  if (provider === "bedrock") {
    return await resolveDefaultBedrockModelMetadata({
      home: opts.home,
      env: opts.env,
    });
  }
  const model = defaultSupportedModel(provider);
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.displayName,
    knowledgeCutoff: model.knowledgeCutoff,
    supportsImageInput: model.supportsImageInput,
    promptTemplate: model.promptTemplate,
    providerOptionsDefaults: { ...model.providerOptionsDefaults },
    source: "static",
  };
}

export function getKnownResolvedModelMetadata(
  provider: ProviderName,
  modelId: string,
  opts: { home?: string } = {},
): ResolvedModelMetadata | null {
  if (provider === "lmstudio") {
    return buildLmStudioPlaceholderMetadata(modelId);
  }
  if (provider === "bedrock") {
    // Read the Bedrock discovery snapshot from the session's auth home (not the
    // process home) so a model discovered under a non-default homedir resumes
    // with its cached metadata instead of migrating to the provider default.
    const known = getKnownBedrockResolvedModelMetadataSync({
      modelId,
      ...(opts.home ? { home: opts.home } : {}),
    });
    if (known) return known;
    // A user-configured Bedrock custom ID may be absent from the static/cache
    // snapshot; resume it as a placeholder instead of migrating to the default.
    if (isConfiguredCustomModelIdSync(provider, modelId, opts)) {
      return buildBedrockPlaceholderMetadata(modelId.trim());
    }
    return null;
  }
  if (provider === "codex-cli") {
    return getResolvedModelMetadataSync(provider, modelId);
  }
  const model = getSupportedModel(provider, modelId);
  if (!model) {
    // Persisted sessions may reference a model id the user configured in the
    // custom-model store or previously discovered from the provider's live
    // catalog; resume with it instead of silently migrating the session to the
    // provider default. (lmstudio/bedrock/codex-cli return in their own
    // branches above, so `provider` here is a dynamic API provider.)
    if (isDynamicModelProvider(provider)) {
      // Prefer the discovered cache entry over the custom placeholder: a
      // custom-managed id that is also in the discovery cache must resume with
      // its real capabilities (vision/reasoning), matching what the catalog
      // advertises, instead of a generic placeholder.
      const discovered = getDiscoveredModelMetadataSync(provider, modelId, opts);
      if (discovered) return discovered;
      if (isConfiguredCustomModelIdSync(provider, modelId, opts)) {
        return buildProviderPlaceholderMetadata(provider, modelId.trim());
      }
    }
    return null;
  }
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.displayName,
    knowledgeCutoff: model.knowledgeCutoff,
    supportsImageInput: model.supportsImageInput,
    promptTemplate: model.promptTemplate,
    providerOptionsDefaults: { ...model.providerOptionsDefaults },
    source: "static",
  };
}
