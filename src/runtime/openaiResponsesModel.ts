import { getSavedProviderApiKey } from "../config";
import { getResolvedModelMetadataSync } from "../models/metadata";

import { type PiModel, pickKnownPiModel } from "./piRuntimeOptions";
import type { RuntimeRunTurnParams } from "./types";

type SupportedResponsesModelLimits = Pick<PiModel, "contextWindow" | "maxTokens">;

// Keep runtime token limits pinned to the supported registry surface so we do not
// inherit unrelated fallback values from PI's broader model catalog.
const SUPPORTED_OPENAI_RESPONSES_MODEL_LIMITS: Record<string, SupportedResponsesModelLimits> = {
  "gpt-5-mini": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.2": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.2-pro": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.4": { contextWindow: 1_050_000, maxTokens: 128_000 },
  "gpt-5.4-mini": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.4-nano": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.4-pro": { contextWindow: 1_050_000, maxTokens: 128_000 },
  "gpt-5.5": { contextWindow: 1_050_000, maxTokens: 128_000 },
};

const OPENAI_RESPONSES_FALLBACK_LIMITS: SupportedResponsesModelLimits = {
  contextWindow: 128_000,
  maxTokens: 16_384,
};

type ResolvedOpenAiResponsesModel = {
  model: PiModel;
  apiKey?: string;
  headers?: Record<string, string>;
  accountId?: string;
};

function applySupportedOpenAiResponsesModel(
  provider: "openai",
  modelId: string,
  model: PiModel,
): PiModel {
  const supported = getResolvedModelMetadataSync(provider, modelId, "model");
  const supportedLimits =
    SUPPORTED_OPENAI_RESPONSES_MODEL_LIMITS[supported.id] ?? OPENAI_RESPONSES_FALLBACK_LIMITS;
  return {
    ...model,
    id: supported.id,
    name: supported.displayName,
    input: supported.supportsImageInput ? ["text", "image"] : ["text"],
    ...supportedLimits,
  };
}

function buildOpenAiResponsesFallbackModel(modelId: string): PiModel {
  return {
    id: modelId,
    name: modelId,
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: modelId.toLowerCase().startsWith("o") || modelId.toLowerCase().startsWith("gpt-5"),
    input: ["text"],
    contextWindow: OPENAI_RESPONSES_FALLBACK_LIMITS.contextWindow,
    maxTokens: OPENAI_RESPONSES_FALLBACK_LIMITS.maxTokens,
  };
}

export async function resolveOpenAiResponsesModel(
  params: RuntimeRunTurnParams,
): Promise<ResolvedOpenAiResponsesModel> {
  const modelId = params.config.model;
  const provider = params.config.provider;

  if (provider !== "openai") {
    throw new Error(`Unsupported provider for OpenAI Responses runtime: ${provider}`);
  }
  const model =
    (await pickKnownPiModel("openai", modelId)) ?? buildOpenAiResponsesFallbackModel(modelId);
  return {
    model: applySupportedOpenAiResponsesModel(provider, modelId, model),
    apiKey: getSavedProviderApiKey(params.config, "openai"),
  };
}
