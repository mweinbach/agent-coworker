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
  type FireworksInferenceProvider,
  getFireworksInferenceModelSpec,
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
  type OpenCodeProviderName,
  resolveOpenCodeApiKey,
} from "../../providers/opencodeShared";
import {
  getTogetherModelSpec,
  resolveTogetherApiKey,
  TOGETHER_BASE_URL,
} from "../../providers/togetherShared";
import { asRecord } from "../../shared/recordParsing";
import type { ProviderName } from "../../types";
import { resolveAuthHomeDir } from "../../utils/authHome";
import { type PiModel, pickExactPiModel, pickKnownPiModel } from "../piRuntimeOptions";
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
  home?: string,
): PiModel {
  const supported = getResolvedModelMetadataSync(provider, modelId, "model", { home });
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

type OpenAiCompatModelPricing = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

type OpenAiCompatKnownSpec = {
  id: string;
  name: string;
  baseUrl: string;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  pricing?: OpenAiCompatModelPricing | null;
  compat?: Record<string, unknown>;
};

type OpenAiCompatPiProviderName =
  | "baseten"
  | "together"
  | FireworksInferenceProvider
  | "nvidia"
  | "minimax"
  | OpenCodeProviderName;

type OpenAiCompatPiProviderEntry = {
  piProvider: string;
  baseUrl: string;
  customCompat?: Record<string, unknown>;
  getKnownSpec: (modelId: string) => OpenAiCompatKnownSpec | null;
  resolveApiKey: (savedKey: string | undefined) => string | undefined;
};

const NVIDIA_CUSTOM_COMPAT: Record<string, unknown> = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  thinkingFormat: "openai",
};

const MINIMAX_COMPAT: Record<string, unknown> = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_completion_tokens",
  thinkingFormat: "openai",
};

function createFireworksPiProviderEntry(
  provider: FireworksInferenceProvider,
): OpenAiCompatPiProviderEntry {
  return {
    piProvider: provider,
    baseUrl: FIREWORKS_INFERENCE_BASE_URL,
    getKnownSpec: (modelId) => getFireworksInferenceModelSpec(provider, modelId),
    resolveApiKey: (savedKey) => resolveFireworksInferenceApiKey(provider, { savedKey }),
  };
}

function createOpenCodePiProviderEntry(
  provider: OpenCodeProviderName,
): OpenAiCompatPiProviderEntry {
  const providerConfig = getOpenCodeProviderConfig(provider);
  return {
    piProvider: "opencode",
    baseUrl: providerConfig.baseUrl,
    getKnownSpec: (modelId) => {
      if (!isOpenCodeModelSupportedByProvider(provider, modelId)) return null;
      const modelSpec = getOpenCodeModelSpec(modelId);
      if (!modelSpec) return null;
      return {
        ...modelSpec,
        baseUrl: providerConfig.baseUrl,
        pricing: getOpenCodeModelPricing(provider, modelId),
      };
    },
    resolveApiKey: (savedKey) => resolveOpenCodeApiKey(provider, { savedKey }),
  };
}

const OPENAI_COMPAT_PI_PROVIDERS: Record<OpenAiCompatPiProviderName, OpenAiCompatPiProviderEntry> =
  {
    baseten: {
      piProvider: "baseten",
      baseUrl: BASETEN_BASE_URL,
      getKnownSpec: (modelId) => getBasetenModelSpec(modelId),
      resolveApiKey: (savedKey) => resolveBasetenApiKey({ savedKey }),
    },
    together: {
      piProvider: "together",
      baseUrl: TOGETHER_BASE_URL,
      getKnownSpec: (modelId) => getTogetherModelSpec(modelId),
      resolveApiKey: (savedKey) => resolveTogetherApiKey({ savedKey }),
    },
    fireworks: createFireworksPiProviderEntry("fireworks"),
    firepass: createFireworksPiProviderEntry("firepass"),
    nvidia: {
      piProvider: "nvidia",
      baseUrl: NVIDIA_BASE_URL,
      customCompat: NVIDIA_CUSTOM_COMPAT,
      getKnownSpec: (modelId) => {
        const modelSpec = getNvidiaModelSpec(modelId);
        return modelSpec ? { ...modelSpec, compat: { ...modelSpec.compat } } : null;
      },
      resolveApiKey: (savedKey) => resolveNvidiaApiKey({ savedKey }),
    },
    minimax: {
      piProvider: "minimax",
      baseUrl: MINIMAX_BASE_URL,
      customCompat: MINIMAX_COMPAT,
      getKnownSpec: (modelId) => {
        const modelSpec = getMinimaxModelSpec(modelId);
        return modelSpec ? { ...modelSpec, compat: MINIMAX_COMPAT } : null;
      },
      resolveApiKey: (savedKey) => resolveMinimaxApiKey({ savedKey }),
    },
    "opencode-go": createOpenCodePiProviderEntry("opencode-go"),
    "opencode-zen": createOpenCodePiProviderEntry("opencode-zen"),
  };

function isOpenAiCompatPiProvider(provider: ProviderName): provider is OpenAiCompatPiProviderName {
  return provider in OPENAI_COMPAT_PI_PROVIDERS;
}

function buildKnownOpenAiCompatiblePiModel(
  piProvider: string,
  modelSpec: OpenAiCompatKnownSpec,
): PiModel {
  return {
    id: modelSpec.id,
    name: modelSpec.name,
    api: "openai-completions",
    provider: piProvider,
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
    ...(modelSpec.compat ? { compat: modelSpec.compat } : {}),
  };
}

async function getBedrockPiModel(modelId: string): Promise<PiModel> {
  const model = await pickExactPiModel("amazon-bedrock", modelId);
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
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: modelId.toLowerCase().includes("claude"),
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 8_192,
  };
}

async function getAnthropicPiModel(modelId: string): Promise<PiModel | null> {
  if (modelId === "claude-opus-4-8") {
    const opus47 = await pickExactPiModel("anthropic", "claude-opus-4-7");
    if (!opus47) return null;
    return {
      ...opus47,
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };
  }

  return await pickExactPiModel("anthropic", modelId);
}

// Fallback for custom/unknown Anthropic model IDs (configured via the custom
// model store). Mirrors buildOpenAiCompatibleCustomPiModel: conservative
// limits and no cost metadata, so usage reporting treats pricing as unknown
// instead of inheriting an unrelated catalog model's rates.
function buildAnthropicCustomPiModel(modelId: string): PiModel {
  return {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: modelId.toLowerCase().includes("claude"),
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

export async function resolvePiModel(
  params: RuntimeRunTurnParams,
): Promise<ResolvedPiRuntimeModel> {
  const modelId = params.config.model;
  const provider = params.config.provider;
  // Custom cross-registry ids are validated against the custom-model store
  // under the session's auth home; thread it through every sync metadata
  // lookup so a configured custom id resolves on the first turn.
  const home = resolveAuthHomeDir(params.config);

  if (provider === "openai") {
    const model = await pickKnownPiModel("openai", modelId);
    if (!model)
      throw new Error(`No PI model metadata available for provider openai (model: ${modelId}).`);
    return {
      model: applySupportedModelMetadata(model, provider, modelId, home),
      apiKey: getSavedProviderApiKey(params.config, "openai"),
    };
  }

  if (provider === "google") {
    throw new Error(
      "Google is handled by the Google Interactions runtime. Set runtime to 'google-interactions'.",
    );
  }

  if (provider === "anthropic") {
    const model = (await getAnthropicPiModel(modelId)) ?? buildAnthropicCustomPiModel(modelId);
    return {
      model: applySupportedModelMetadata(model, provider, modelId, home),
      apiKey: getSavedProviderApiKey(params.config, "anthropic"),
    };
  }

  if (provider === "bedrock") {
    const auth = await resolveBedrockAuthConfig({ config: params.config });
    const streamOptions = auth ? bedrockClientConfig(auth) : undefined;
    return {
      model: applySupportedModelMetadata(await getBedrockPiModel(modelId), provider, modelId, home),
      ...(streamOptions ? { streamOptions } : {}),
    };
  }

  if (isOpenAiCompatPiProvider(provider)) {
    const entry = OPENAI_COMPAT_PI_PROVIDERS[provider];
    const knownSpec = entry.getKnownSpec(modelId);
    const model = knownSpec
      ? buildKnownOpenAiCompatiblePiModel(entry.piProvider, knownSpec)
      : buildOpenAiCompatibleCustomPiModel({
          modelId,
          provider: entry.piProvider,
          baseUrl: entry.baseUrl,
          compat: entry.customCompat,
        });
    return {
      model: applySupportedModelMetadata(model, provider, modelId, home),
      apiKey: entry.resolveApiKey(getSavedProviderApiKey(params.config, provider)),
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

  if (provider === "codex-cli") {
    throw new Error("codex-cli is handled by the Codex app-server runtime.");
  }

  const exhaustive: never = provider;
  throw new Error(`Unsupported provider for PI runtime: ${String(exhaustive)}`);
}
