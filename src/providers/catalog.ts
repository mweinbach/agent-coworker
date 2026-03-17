import type { ProviderName } from "../types";
import { defaultModelIdForProvider, listSupportedModelIds } from "../models/registry";

type ProviderModelDefinition = {
  defaultModel: string;
  availableModels: readonly string[];
};

export const USER_FACING_DISABLED_PROVIDERS = ["baseten"] as const satisfies readonly ProviderName[];
const USER_FACING_DISABLED_PROVIDER_SET = new Set<ProviderName>(USER_FACING_DISABLED_PROVIDERS);

export function isUserFacingProviderEnabled(provider: ProviderName): boolean {
  return !USER_FACING_DISABLED_PROVIDER_SET.has(provider);
}

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
  nvidia: {
    defaultModel: defaultModelIdForProvider("nvidia"),
    availableModels: listSupportedModelIds("nvidia"),
  },
  "opencode-go": {
    defaultModel: defaultModelIdForProvider("opencode-go"),
    availableModels: listSupportedModelIds("opencode-go"),
  },
  "opencode-zen": {
    defaultModel: defaultModelIdForProvider("opencode-zen"),
    availableModels: listSupportedModelIds("opencode-zen"),
  },
  "openai-proxy": {
    defaultModel: defaultModelIdForProvider("openai-proxy"),
    availableModels: listSupportedModelIds("openai-proxy"),
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

export function userFacingAvailableModelsForProvider(provider: ProviderName): readonly string[] {
  return isUserFacingProviderEnabled(provider) ? availableModelsForProvider(provider) : [];
}

export const PROVIDER_MODEL_CHOICES: Record<ProviderName, readonly string[]> = {
  anthropic: PROVIDER_MODEL_CATALOG.anthropic.availableModels,
  baseten: PROVIDER_MODEL_CATALOG.baseten.availableModels,
  together: PROVIDER_MODEL_CATALOG.together.availableModels,
  nvidia: PROVIDER_MODEL_CATALOG.nvidia.availableModels,
  "opencode-go": PROVIDER_MODEL_CATALOG["opencode-go"].availableModels,
  "opencode-zen": PROVIDER_MODEL_CATALOG["opencode-zen"].availableModels,
  "openai-proxy": PROVIDER_MODEL_CATALOG["openai-proxy"].availableModels,
  "codex-cli": PROVIDER_MODEL_CATALOG["codex-cli"].availableModels,
  google: PROVIDER_MODEL_CATALOG.google.availableModels,
  openai: PROVIDER_MODEL_CATALOG.openai.availableModels,
};

export function modelChoicesByProvider(): Record<ProviderName, readonly string[]> {
  return PROVIDER_MODEL_CHOICES;
}

export function userFacingProviders(): ProviderName[] {
  return (Object.keys(PROVIDER_MODEL_CATALOG) as ProviderName[]).filter((provider) => isUserFacingProviderEnabled(provider));
}
