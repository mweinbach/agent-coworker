import { PROVIDER_NAMES, PROVIDER_SPECS } from "../generated/providerSpecs";
import {
  defaultModelIdForProvider,
  getSupportedModel,
  listSupportedModelIds,
  type SupportedModel,
} from "../models/registry";
import {
  GOOGLE_DYNAMIC_REASONING_EFFORT,
  listGoogleReasoningEffortValuesForModel,
} from "../shared/googleThinking";
import {
  type CatalogReasoningEffort,
  DEFAULT_OPENAI_REASONING_EFFORT_VALUES,
  isOpenAiReasoningEffort,
  OPENAI_REASONING_EFFORT_VALUES,
  type OpenAiReasoningEffort,
} from "../shared/openaiCompatibleOptions";
import type { ProviderName } from "../types";

type ProviderModelDefinition = {
  defaultModel: string;
  availableModels: readonly string[];
};

export function isUserFacingProviderEnabled(provider: ProviderName): boolean {
  return PROVIDER_SPECS[provider].userFacing;
}

function providerModelDefinition(provider: ProviderName): ProviderModelDefinition {
  // Local-discovery providers (LM Studio) have no static registry; their models come from the
  // live catalog only.
  if (PROVIDER_SPECS[provider].discovery === "local") {
    return { defaultModel: "", availableModels: [] };
  }
  return {
    defaultModel: defaultModelIdForProvider(provider),
    availableModels: listSupportedModelIds(provider),
  };
}

const PROVIDER_MODEL_CATALOG = Object.fromEntries(
  PROVIDER_NAMES.map((provider) => [provider, providerModelDefinition(provider)]),
) as Record<ProviderName, ProviderModelDefinition>;

export function defaultModelForProvider(provider: ProviderName): string {
  return PROVIDER_MODEL_CATALOG[provider].defaultModel;
}

function availableModelsForProvider(provider: ProviderName): readonly string[] {
  return PROVIDER_MODEL_CATALOG[provider].availableModels;
}

export function userFacingAvailableModelsForProvider(provider: ProviderName): readonly string[] {
  return isUserFacingProviderEnabled(provider) ? availableModelsForProvider(provider) : [];
}

/**
 * Derives the OpenAI-compatible reasoning config for a registry model. Uses the
 * model's declared `supportedReasoningEfforts` when present (canonical order,
 * default effort always included); falls back to the default effort set
 * otherwise ("light" and "max" are never assumed — models must declare them).
 */
function openAiReasoningConfigForSupportedModel(
  model: Pick<SupportedModel, "providerOptionsDefaults" | "supportedReasoningEfforts">,
): { defaultEffort: OpenAiReasoningEffort; availableEfforts: OpenAiReasoningEffort[] } | null {
  const defaultEffort = model.providerOptionsDefaults.reasoningEffort;
  if (!isOpenAiReasoningEffort(defaultEffort)) return null;
  const declared = new Set<OpenAiReasoningEffort>([
    defaultEffort,
    ...(model.supportedReasoningEfforts ?? DEFAULT_OPENAI_REASONING_EFFORT_VALUES),
  ]);
  return {
    defaultEffort,
    availableEfforts: OPENAI_REASONING_EFFORT_VALUES.filter((effort) => declared.has(effort)),
  };
}

export function reasoningConfigForProviderModel(
  provider: ProviderName,
  modelId: string,
): { defaultEffort: CatalogReasoningEffort; availableEfforts: CatalogReasoningEffort[] } | null {
  const supportedModel = getSupportedModel(provider, modelId.trim());
  if (!supportedModel) return null;
  if (supportedModel.provider === "google") {
    return {
      defaultEffort: GOOGLE_DYNAMIC_REASONING_EFFORT,
      availableEfforts: [...new Set(listGoogleReasoningEffortValuesForModel(supportedModel.id))],
    };
  }
  const openAiConfig = openAiReasoningConfigForSupportedModel(supportedModel);
  return openAiConfig
    ? { defaultEffort: openAiConfig.defaultEffort, availableEfforts: openAiConfig.availableEfforts }
    : null;
}
