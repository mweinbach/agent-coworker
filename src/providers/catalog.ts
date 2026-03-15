import type { ProviderName } from "../types";
import { defaultModelIdForProvider, listSupportedModelIds } from "../models/registry";

type ProviderModelDefinition = {
  defaultModel: string;
  availableModels: readonly string[];
};

export const PROVIDER_MODEL_CATALOG = {
  anthropic: {
    defaultModel: defaultModelIdForProvider("anthropic"),
    availableModels: listSupportedModelIds("anthropic"),
  },
  baseten: {
    defaultModel: defaultModelIdForProvider("baseten"),
    availableModels: listSupportedModelIds("baseten"),
  },
  together: {
    defaultModel: defaultModelIdForProvider("together"),
    availableModels: listSupportedModelIds("together"),
  },
  "opencode-go": {
    defaultModel: defaultModelIdForProvider("opencode-go"),
    availableModels: listSupportedModelIds("opencode-go"),
  },
  "opencode-zen": {
    defaultModel: defaultModelIdForProvider("opencode-zen"),
    availableModels: listSupportedModelIds("opencode-zen"),
  },
  "codex-cli": {
    defaultModel: defaultModelIdForProvider("codex-cli"),
    availableModels: listSupportedModelIds("codex-cli"),
  },
  google: {
    defaultModel: defaultModelIdForProvider("google"),
    availableModels: listSupportedModelIds("google"),
  },
  openai: {
    defaultModel: defaultModelIdForProvider("openai"),
    availableModels: listSupportedModelIds("openai"),
  },
} as const satisfies Record<ProviderName, ProviderModelDefinition>;

export function defaultModelForProvider(provider: ProviderName): string {
  return PROVIDER_MODEL_CATALOG[provider].defaultModel;
}

export function availableModelsForProvider(provider: ProviderName): readonly string[] {
  return PROVIDER_MODEL_CATALOG[provider].availableModels;
}

export const PROVIDER_MODEL_CHOICES: Record<ProviderName, readonly string[]> = {
  anthropic: PROVIDER_MODEL_CATALOG.anthropic.availableModels,
  baseten: PROVIDER_MODEL_CATALOG.baseten.availableModels,
  together: PROVIDER_MODEL_CATALOG.together.availableModels,
  "opencode-go": PROVIDER_MODEL_CATALOG["opencode-go"].availableModels,
  "opencode-zen": PROVIDER_MODEL_CATALOG["opencode-zen"].availableModels,
  "codex-cli": PROVIDER_MODEL_CATALOG["codex-cli"].availableModels,
  google: PROVIDER_MODEL_CATALOG.google.availableModels,
  openai: PROVIDER_MODEL_CATALOG.openai.availableModels,
};

export function modelChoicesByProvider(): Record<ProviderName, readonly string[]> {
  return PROVIDER_MODEL_CHOICES;
}
