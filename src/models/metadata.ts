import {
  buildBedrockPlaceholderMetadata,
  getKnownBedrockResolvedModelMetadataSync,
  resolveBedrockModelMetadata,
  resolveDefaultBedrockModelMetadata,
} from "../providers/bedrockShared";
import {
  buildLmStudioPlaceholderMetadata,
  resolveDefaultLmStudioModelMetadata,
  resolveLmStudioDiscoveredModelMetadata,
} from "../providers/lmstudio/catalog";
import { readModelDiscoveryCache } from "../providers/modelDiscoveryCache";
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
  | "opencode-zen";

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

function buildProviderPlaceholderMetadata(
  provider: Exclude<DynamicModelProvider, "lmstudio" | "bedrock">,
  modelId: string,
): ResolvedModelMetadata {
  const fallback = defaultSupportedModel(provider);
  return {
    id: modelId,
    provider,
    displayName: modelId,
    knowledgeCutoff: "Unknown",
    supportsImageInput: false,
    promptTemplate: fallback.promptTemplate,
    providerOptionsDefaults: { ...fallback.providerOptionsDefaults },
    source: "dynamic",
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
    provider === "opencode-zen"
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

export function normalizeModelIdForProvider(
  provider: ProviderName,
  modelId: string,
  source = "model",
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
    // provably belong to a different provider are rejected with guidance.
    if (isModelIdForeignToProvider(provider, trimmed)) {
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
): ResolvedModelMetadata {
  if (provider === "lmstudio") {
    return buildLmStudioPlaceholderMetadata(normalizeModelIdForProvider(provider, modelId, source));
  }
  if (provider === "bedrock") {
    return (
      getKnownBedrockResolvedModelMetadataSync({
        modelId: normalizeModelIdForProvider(provider, modelId, source),
      }) ?? buildBedrockPlaceholderMetadata(normalizeModelIdForProvider(provider, modelId, source))
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
      normalizeModelIdForProvider(provider, modelId, source),
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
    return buildProviderPlaceholderMetadata(
      provider,
      normalizeModelIdForProvider(provider, modelId, source),
    );
  }
  return toResolvedStaticModel(provider, modelId, source);
}

/**
 * Placeholder metadata for a model previously discovered from the provider's
 * live catalog (persisted under `~/.cowork/cache/models/<provider>.json`).
 * Returns null when the id is not present in the discovery cache.
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
  if (provider === "codex-cli") {
    return getResolvedModelMetadataSync(provider, modelId, opts.source);
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
      // accepted when they were previously discovered from the provider.
      const discovered = await getDiscoveredModelMetadata(provider, trimmed, {
        ...(opts.home ? { home: opts.home } : {}),
      });
      if (discovered) return discovered;
      return toResolvedStaticModel(provider, trimmed, opts.source);
    }
    return getResolvedModelMetadataSync(provider, modelId, opts.source);
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
): ResolvedModelMetadata | null {
  if (provider === "lmstudio") {
    return buildLmStudioPlaceholderMetadata(modelId);
  }
  if (provider === "bedrock") {
    return getKnownBedrockResolvedModelMetadataSync({ modelId });
  }
  if (provider === "codex-cli") {
    return getResolvedModelMetadataSync(provider, modelId);
  }
  const model = getSupportedModel(provider, modelId);
  if (!model) return null;
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
