import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildBedrockPlaceholderMetadata,
  getKnownBedrockResolvedModelMetadataSync,
  resolveBedrockModelMetadata,
  resolveDefaultBedrockModelMetadata,
} from "../providers/bedrockShared";
import { readCustomModelStore } from "../providers/customModels";
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
import { getAiCoworkerPaths } from "../store/connections";
import type { ProviderName } from "../types";
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
  // Other providers have no cheap id-only heuristic; keep their reasoning
  // defaults rather than risk stripping a payload the model needs.
  return true;
}

function stripReasoningProviderOptionDefaults(
  provider: Exclude<DynamicModelProvider, "lmstudio" | "bedrock">,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const keys = REASONING_PROVIDER_OPTION_KEYS[provider];
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
  const keys = REASONING_PROVIDER_OPTION_KEYS[provider];
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
  const providerOptionsDefaults = supportsReasoning
    ? { ...fallback.providerOptionsDefaults }
    : stripReasoningProviderOptionDefaults(provider, { ...fallback.providerOptionsDefaults });
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
  return {
    ...base,
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
      // accepted when configured by the user or previously discovered from the provider.
      const custom = await getCustomModelMetadata(provider, trimmed, homeOpts);
      if (custom) return custom;
      const discovered = await getDiscoveredModelMetadata(provider, trimmed, homeOpts);
      if (discovered) return discovered;
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
    return await resolveLmStudioDiscoveredModelMetadata({
      modelId: normalizedModelId,
      providerOptions: opts.providerOptions,
      env: opts.env,
      fetchImpl: opts.fetchImpl,
    });
  } catch (error) {
    if (opts.allowPlaceholder) {
      opts.log?.(
        `[lmstudio] using conservative placeholder metadata for ${normalizedModelId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return buildLmStudioPlaceholderMetadata(normalizedModelId);
    }
    throw error;
  }
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
      if (isConfiguredCustomModelIdSync(provider, modelId, opts)) {
        return buildProviderPlaceholderMetadata(provider, modelId.trim());
      }
      const discovered = getDiscoveredModelMetadataSync(provider, modelId, opts);
      if (discovered) return discovered;
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
