import { getSavedProviderApiKey } from "../config";
import { assertSupportedModel } from "../models/registry";

import { type PiModel, pickKnownPiModel } from "./piRuntimeOptions";
import type { RuntimeRunTurnParams } from "./types";

type SupportedResponsesModelLimits = Pick<PiModel, "contextWindow" | "maxTokens">;

// Keep runtime token limits pinned to the supported registry surface so we do not
// inherit unrelated fallback values from PI's broader model catalog.
const SUPPORTED_OPENAI_RESPONSES_MODEL_LIMITS: Record<string, SupportedResponsesModelLimits> = {
  "gpt-5-mini": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.2": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.2-pro": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.4": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.4-mini": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.5": { contextWindow: 1_050_000, maxTokens: 128_000 },
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
  const supported = assertSupportedModel(provider, modelId, "model");
  const supportedLimits = SUPPORTED_OPENAI_RESPONSES_MODEL_LIMITS[supported.id];
  if (!supportedLimits) {
    throw new Error(
      `Missing supported OpenAI Responses model limits for openai model ${supported.id}.`,
    );
  }
  return {
    ...model,
    id: supported.id,
    name: supported.id,
    input: supported.supportsImageInput ? ["text", "image"] : ["text"],
    ...(supportedLimits ?? {}),
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
  const model = pickKnownPiModel("openai", modelId);
  if (!model) {
    throw new Error(
      `No OpenAI Responses model metadata available for provider openai (model: ${modelId}).`,
    );
  }
  return {
    model: applySupportedOpenAiResponsesModel(provider, modelId, model),
    apiKey: getSavedProviderApiKey(params.config, "openai"),
  };
}
