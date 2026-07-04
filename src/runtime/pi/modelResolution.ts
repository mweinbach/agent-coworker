import { getSavedProviderApiKey } from "../../config";
import { getResolvedModelMetadataSync } from "../../models/metadata";
import {
  BASETEN_BASE_URL,
  getBasetenModelSpec,
  resolveBasetenApiKey,
} from "../../providers/basetenShared";
import { bedrockClientConfig, resolveBedrockAuthConfig } from "../../providers/bedrockShared";
import {
  FIREWORKS_INFERENCE_BASE_URL,
  getFireworksInferenceModelSpec,
  isFireworksInferenceProvider,
  resolveFireworksInferenceApiKey,
} from "../../providers/fireworksShared";
import { prepareLmStudioModelMetadataForInference } from "../../providers/lmstudio/catalog";
import { lmStudioOpenAiBaseUrl } from "../../providers/lmstudio/client";
import {
  getMinimaxModelSpec,
  MINIMAX_BASE_URL,
  resolveMinimaxApiKey,
} from "../../providers/minimaxShared";
import {
  getNvidiaModelSpec,
  NVIDIA_BASE_URL,
  resolveNvidiaApiKey,
} from "../../providers/nvidiaShared";
import {
  getOpenCodeModelPricing,
  getOpenCodeModelSpec,
  getOpenCodeProviderConfig,
  isOpenCodeModelSupportedByProvider,
  isOpenCodeProviderName,
  type OpenCodeProviderName,
  resolveOpenCodeApiKey,
} from "../../providers/opencodeShared";
import {
  getTogetherModelSpec,
  resolveTogetherApiKey,
  TOGETHER_BASE_URL,
} from "../../providers/togetherShared";
import type { ProviderName } from "../../types";
import { asRecord, type PiModel, pickKnownPiModel } from "../piRuntimeOptions";
import type { RuntimeRunTurnParams } from "../types";
import {
  LM_STUDIO_LOCAL_SENTINEL_API_KEY,
  PI_PLACEHOLDER_COST,
  type ResolvedPiRuntimeModel,
} from "./types";

export function preparePiModelForStream(model: PiModel): PiModel {
  if (model.cost) return model;
  return {
    ...model,
    cost: { ...PI_PLACEHOLDER_COST },
  };
}

export function stripPlaceholderCostFromAssistantRecord(
  assistant: Record<string, unknown>,
  model: PiModel,
): Record<string, unknown> {
  if (model.cost) return assistant;
  const usage = asRecord(assistant.usage);
  if (!usage || !("cost" in usage)) return assistant;
  const nextUsage = { ...usage };
  delete nextUsage.cost;
  return {
    ...assistant,
    usage: nextUsage,
  };
}

function applySupportedModelMetadata(
  model: PiModel,
  provider: ProviderName,
  modelId: string,
): PiModel {
  const supported = getResolvedModelMetadataSync(provider, modelId, "model");
  const input: Array<"text" | "image"> = supported.supportsImageInput
    ? ["text", "image"]
    : ["text"];
  return {
    ...model,
    id: supported.id,
    name: supported.displayName,
    input,
  };
}

function safeLmStudioMaxTokens(contextWindow: number): number {
  return Math.max(1, Math.floor(contextWindow / 4));
}

function buildLmStudioPiModel(opts: {
  metadata: ReturnType<typeof getResolvedModelMetadataSync>;
  baseUrl: string;
}): PiModel {
  const contextWindow =
    opts.metadata.effectiveContextLength ?? opts.metadata.maxContextLength ?? 8192;
  return {
    id: opts.metadata.id,
    name: opts.metadata.displayName,
    api: "openai-completions",
    provider: "lmstudio",
    baseUrl: lmStudioOpenAiBaseUrl(opts.baseUrl),
    reasoning: false,
    input: opts.metadata.supportsImageInput ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens: safeLmStudioMaxTokens(contextWindow),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
    },
  };
}

function buildOpenAiCompatibleCustomPiModel(opts: {
  modelId: string;
  provider: string;
  baseUrl: string;
  compat?: Record<string, unknown>;
}): PiModel {
  return {
    id: opts.modelId,
    name: opts.modelId,
    api: "openai-completions",
    provider: opts.provider,
    baseUrl: opts.baseUrl,
    reasoning: false,
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 8_192,
    ...(opts.compat ? { compat: opts.compat } : {}),
  };
}

function getOpenCodePiModel(provider: OpenCodeProviderName, modelId: string): PiModel | null {
  if (!isOpenCodeModelSupportedByProvider(provider, modelId)) return null;
  const modelSpec = getOpenCodeModelSpec(modelId);
  if (!modelSpec) return null;
  const pricing = getOpenCodeModelPricing(provider, modelId);

  const providerConfig = getOpenCodeProviderConfig(provider);
  return {
    id: modelSpec.id,
    name: modelSpec.name,
    api: "openai-completions",
    provider: "opencode",
    baseUrl: providerConfig.baseUrl,
    reasoning: modelSpec.reasoning,
    input: [...modelSpec.input],
    ...(pricing
      ? {
          cost: {
            input: pricing.input,
            output: pricing.output,
            cacheRead: pricing.cacheRead,
            cacheWrite: pricing.cacheWrite,
          },
        }
      : {}),
    contextWindow: modelSpec.contextWindow,
    maxTokens: modelSpec.maxTokens,
  };
}

function getBasetenPiModel(modelId: string): PiModel | null {
  const modelSpec = getBasetenModelSpec(modelId);
  if (!modelSpec) return null;

  return {
    id: modelSpec.id,
    name: modelSpec.name,
    api: "openai-completions",
    provider: "baseten",
    baseUrl: modelSpec.baseUrl,
    reasoning: modelSpec.reasoning,
    input: [...modelSpec.input],
    ...(modelSpec.pricing
      ? {
          cost: {
            input: modelSpec.pricing.input,
            output: modelSpec.pricing.output,
            cacheRead: modelSpec.pricing.cacheRead ?? 0,
            cacheWrite: modelSpec.pricing.cacheWrite ?? 0,
          },
        }
      : {}),
    contextWindow: modelSpec.contextWindow,
    maxTokens: modelSpec.maxTokens,
  };
}

async function getBedrockPiModel(modelId: string): Promise<PiModel> {
  const model = await pickKnownPiModel("amazon-bedrock", modelId);
  if (model) {
    return {
      ...model,
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
    };
  }

  return {
    id: modelId,
    name: modelId,
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime",
    reasoning: modelId.toLowerCase().includes("claude"),
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 8_192,
  };
}

async function getAnthropicPiModel(modelId: string): Promise<PiModel | null> {
  if (modelId === "claude-opus-4-8") {
    const opus47 = await pickKnownPiModel("anthropic", "claude-opus-4-7");
    if (!opus47) return null;
    return {
      ...opus47,
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };
  }

  const model = await pickKnownPiModel("anthropic", modelId);
  if (model) return model;

  return null;
}

function getTogetherPiModel(modelId: string): PiModel | null {
  const modelSpec = getTogetherModelSpec(modelId);
  if (!modelSpec) return null;

  return {
    id: modelSpec.id,
    name: modelSpec.name,
    api: "openai-completions",
    provider: "together",
    baseUrl: modelSpec.baseUrl,
    reasoning: modelSpec.reasoning,
    input: [...modelSpec.input],
    cost: {
      input: modelSpec.pricing.input,
      output: modelSpec.pricing.output,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: modelSpec.contextWindow,
    maxTokens: modelSpec.maxTokens,
  };
}

function getFireworksInferencePiModel(
  provider: "fireworks" | "firepass",
  modelId: string,
): PiModel | null {
  const modelSpec = getFireworksInferenceModelSpec(provider, modelId);
  if (!modelSpec) return null;

  return {
    id: modelSpec.id,
    name: modelSpec.name,
    api: "openai-completions",
    provider,
    baseUrl: modelSpec.baseUrl,
    reasoning: modelSpec.reasoning,
    input: [...modelSpec.input],
    cost: {
      input: modelSpec.pricing.input,
      output: modelSpec.pricing.output,
      cacheRead: modelSpec.pricing.cacheRead ?? 0,
      cacheWrite: modelSpec.pricing.cacheWrite ?? 0,
    },
    contextWindow: modelSpec.contextWindow,
    maxTokens: modelSpec.maxTokens,
  };
}

function getNvidiaPiModel(modelId: string): PiModel | null {
  const modelSpec = getNvidiaModelSpec(modelId);
  if (!modelSpec) return null;

  return {
    id: modelSpec.id,
    name: modelSpec.name,
    api: "openai-completions",
    provider: "nvidia",
    baseUrl: modelSpec.baseUrl,
    reasoning: modelSpec.reasoning,
    input: [...modelSpec.input],
    contextWindow: modelSpec.contextWindow,
    maxTokens: modelSpec.maxTokens,
    compat: { ...modelSpec.compat },
  };
}

function getMinimaxPiModel(modelId: string): PiModel | null {
  const modelSpec = getMinimaxModelSpec(modelId);
  if (!modelSpec) return null;

  return {
    id: modelSpec.id,
    name: modelSpec.name,
    api: "openai-completions",
    provider: "minimax",
    baseUrl: modelSpec.baseUrl,
    reasoning: modelSpec.reasoning,
    input: [...modelSpec.input],
    cost: {
      input: modelSpec.pricing.input,
      output: modelSpec.pricing.output,
      cacheRead: modelSpec.pricing.cacheRead,
      cacheWrite: modelSpec.pricing.cacheWrite,
    },
    contextWindow: modelSpec.contextWindow,
    maxTokens: modelSpec.maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_completion_tokens",
      thinkingFormat: "openai",
    },
  };
}

export async function resolvePiModel(
  params: RuntimeRunTurnParams,
): Promise<ResolvedPiRuntimeModel> {
  const modelId = params.config.model;
  const provider = params.config.provider;

  if (provider === "openai") {
    const model = await pickKnownPiModel("openai", modelId);
    if (!model)
      throw new Error(`No PI model metadata available for provider openai (model: ${modelId}).`);
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: getSavedProviderApiKey(params.config, "openai"),
    };
  }

  if (provider === "google") {
    throw new Error(
      "Google is handled by the Google Interactions runtime. Set runtime to 'google-interactions'.",
    );
  }

  if (provider === "anthropic") {
    const model = await getAnthropicPiModel(modelId);
    if (!model)
      throw new Error(`No PI model metadata available for provider anthropic (model: ${modelId}).`);
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: getSavedProviderApiKey(params.config, "anthropic"),
    };
  }

  if (provider === "bedrock") {
    const auth = await resolveBedrockAuthConfig({ config: params.config });
    const streamOptions = auth ? bedrockClientConfig(auth) : undefined;
    return {
      model: applySupportedModelMetadata(await getBedrockPiModel(modelId), provider, modelId),
      ...(streamOptions ? { streamOptions } : {}),
    };
  }

  if (provider === "baseten") {
    const model =
      getBasetenPiModel(modelId) ??
      buildOpenAiCompatibleCustomPiModel({
        modelId,
        provider: "baseten",
        baseUrl: BASETEN_BASE_URL,
      });
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: resolveBasetenApiKey({
        savedKey: getSavedProviderApiKey(params.config, "baseten"),
      }),
    };
  }

  if (provider === "together") {
    const model =
      getTogetherPiModel(modelId) ??
      buildOpenAiCompatibleCustomPiModel({
        modelId,
        provider: "together",
        baseUrl: TOGETHER_BASE_URL,
      });
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: resolveTogetherApiKey({
        savedKey: getSavedProviderApiKey(params.config, "together"),
      }),
    };
  }

  if (isFireworksInferenceProvider(provider)) {
    const model =
      getFireworksInferencePiModel(provider, modelId) ??
      buildOpenAiCompatibleCustomPiModel({
        modelId,
        provider,
        baseUrl: FIREWORKS_INFERENCE_BASE_URL,
      });
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: resolveFireworksInferenceApiKey(provider, {
        savedKey: getSavedProviderApiKey(params.config, provider),
      }),
    };
  }

  if (provider === "nvidia") {
    const model =
      getNvidiaPiModel(modelId) ??
      buildOpenAiCompatibleCustomPiModel({
        modelId,
        provider: "nvidia",
        baseUrl: NVIDIA_BASE_URL,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
          thinkingFormat: "openai",
        },
      });
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: resolveNvidiaApiKey({
        savedKey: getSavedProviderApiKey(params.config, "nvidia"),
      }),
    };
  }

  if (provider === "minimax") {
    const model =
      getMinimaxPiModel(modelId) ??
      buildOpenAiCompatibleCustomPiModel({
        modelId,
        provider: "minimax",
        baseUrl: MINIMAX_BASE_URL,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_completion_tokens",
          thinkingFormat: "openai",
        },
      });
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: resolveMinimaxApiKey({
        savedKey: getSavedProviderApiKey(params.config, "minimax"),
      }),
    };
  }

  if (provider === "lmstudio") {
    const prepared = await prepareLmStudioModelMetadataForInference({
      modelId,
      providerOptions: params.providerOptions ?? params.config.providerOptions,
      log: params.log,
    });
    const configuredApiKey =
      prepared.provider.apiKey ?? getSavedProviderApiKey(params.config, "lmstudio");
    return {
      model: buildLmStudioPiModel({
        metadata: prepared.metadata,
        baseUrl: prepared.provider.baseUrl,
      }),
      // pi-ai's OpenAI-compatible client refuses to initialize without a truthy apiKey,
      // even for local endpoints that do not require authentication.
      apiKey: configuredApiKey ?? LM_STUDIO_LOCAL_SENTINEL_API_KEY,
      ...(configuredApiKey
        ? {
            headers: {
              authorization: `Bearer ${configuredApiKey}`,
            },
          }
        : {}),
    };
  }

  if (isOpenCodeProviderName(provider)) {
    const providerConfig = getOpenCodeProviderConfig(provider);
    const model =
      getOpenCodePiModel(provider, modelId) ??
      buildOpenAiCompatibleCustomPiModel({
        modelId,
        provider: "opencode",
        baseUrl: providerConfig.baseUrl,
      });
    return {
      model: applySupportedModelMetadata(model, provider, modelId),
      apiKey: resolveOpenCodeApiKey(provider, {
        savedKey: getSavedProviderApiKey(params.config, provider),
      }),
    };
  }

  if (provider === "codex-cli") {
    throw new Error("codex-cli is handled by the Codex app-server runtime.");
  }

  if (provider === "antigravity") {
    throw new Error("Antigravity is handled by the Antigravity runtime.");
  }

  const exhaustive: never = provider;
  throw new Error(`Unsupported provider for PI runtime: ${String(exhaustive)}`);
}
