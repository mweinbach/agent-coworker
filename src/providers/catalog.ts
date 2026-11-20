import { getSupportedModel, type SupportedModel } from "../models/registry";
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
