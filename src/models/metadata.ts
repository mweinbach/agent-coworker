import {
  buildLmStudioPlaceholderMetadata,
  resolveDefaultLmStudioModelMetadata,
  resolveLmStudioDiscoveredModelMetadata,
} from "../providers/lmstudio/catalog";
import {
  resolveAwsBedrockProxyDiscoveredModel,
  type AwsBedrockProxyResolutionConfig,
} from "../providers/awsBedrockProxyShared";
import type { AgentConfig, ProviderName } from "../types";
import {
  assertSupportedModel,
  defaultSupportedModel,
  getSupportedModel,
} from "./registry";
import type { ResolvedModelMetadata } from "./metadataTypes";

function toResolvedStaticModel(provider: ProviderName, modelId: string, source = "model"): ResolvedModelMetadata {
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

function toResolvedDynamicModel(
  provider: ProviderName,
  modelId: string,
  overrides: Partial<Pick<ResolvedModelMetadata, "displayName" | "knowledgeCutoff" | "supportsImageInput">> = {},
): ResolvedModelMetadata {
  const fallback = defaultSupportedModel(provider);
  return {
    id: modelId,
    provider,
    displayName: overrides.displayName ?? modelId,
    knowledgeCutoff: overrides.knowledgeCutoff ?? fallback.knowledgeCutoff,
    supportsImageInput: overrides.supportsImageInput ?? fallback.supportsImageInput,
    promptTemplate: fallback.promptTemplate,
    providerOptionsDefaults: { ...fallback.providerOptionsDefaults },
    source: "dynamic",
  };
}

export function isDynamicModelProvider(provider: ProviderName): provider is "lmstudio" | "aws-bedrock-proxy" {
  return provider === "lmstudio" || provider === "aws-bedrock-proxy";
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
  if (isDynamicModelProvider(provider)) {
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
  if (provider === "aws-bedrock-proxy") {
    return toResolvedDynamicModel(provider, normalizeModelIdForProvider(provider, modelId, source));
  }
  return toResolvedStaticModel(provider, modelId, source);
}

export async function resolveModelMetadata(
  provider: ProviderName,
  modelId: string,
  opts: {
    allowPlaceholder?: boolean;
    /** Session/config slice so global `awsBedrockProxyBaseUrl` matches runtime discovery precedence. */
    config?: AgentConfig | AwsBedrockProxyResolutionConfig;
    /**
     * Connection-store API key for `aws-bedrock-proxy` so `/models` discovery matches runtime auth
     * when the token is not in env. Combined with `env` inside `resolveAwsBedrockProxyApiKey`.
     */
    awsBedrockProxySavedApiKey?: string;
    providerOptions?: unknown;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    source?: string;
    log?: (line: string) => void;
  } = {},
): Promise<ResolvedModelMetadata> {
  if (provider === "aws-bedrock-proxy") {
    const normalizedModelId = normalizeModelIdForProvider(provider, modelId, opts.source);
    const discovered = await resolveAwsBedrockProxyDiscoveredModel({
      modelId: normalizedModelId,
      apiKey: opts.awsBedrockProxySavedApiKey,
      config: opts.config,
      providerOptions: opts.providerOptions,
      env: opts.env,
      fetchImpl: opts.fetchImpl,
    });
    if (discovered) {
      return toResolvedDynamicModel(provider, discovered.id, {
        displayName: discovered.displayName,
        knowledgeCutoff: discovered.knowledgeCutoff,
        supportsImageInput: discovered.supportsImageInput,
      });
    }
    return toResolvedDynamicModel(provider, normalizedModelId);
  }
  if (provider !== "lmstudio") {
    return toResolvedStaticModel(provider, modelId, opts.source);
  }

  const normalizedModelId = normalizeModelIdForProvider(provider, modelId, opts.source);
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
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ResolvedModelMetadata> {
  if (provider === "lmstudio") {
    return await resolveDefaultLmStudioModelMetadata(opts);
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
  if (provider === "aws-bedrock-proxy") {
    return toResolvedDynamicModel(provider, modelId);
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
