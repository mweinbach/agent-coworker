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

const STATIC_PROVIDER_MODEL_CATALOG = {
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
  fireworks: {
    defaultModel: defaultModelIdForProvider("fireworks"),
    availableModels: listSupportedModelIds("fireworks"),
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
  "codex-cli": {
    defaultModel: defaultModelIdForProvider("codex-cli"),
    availableModels: listSupportedModelIds("codex-cli"),
  },
  "aws-bedrock-proxy": {
    defaultModel: defaultModelIdForProvider("aws-bedrock-proxy"),
    availableModels: listSupportedModelIds("aws-bedrock-proxy"),
  },
  google: {
    defaultModel: defaultModelIdForProvider("google"),
    availableModels: listSupportedModelIds("google"),
  },
  openai: {
    defaultModel: defaultModelIdForProvider("openai"),
    availableModels: listSupportedModelIds("openai"),
  },
} as const satisfies Record<Exclude<ProviderName, "lmstudio">, ProviderModelDefinition>;

export const PROVIDER_MODEL_CATALOG: Record<ProviderName, ProviderModelDefinition> = {
  ...STATIC_PROVIDER_MODEL_CATALOG,
  lmstudio: {
    defaultModel: "",
    availableModels: [],
  },
};

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
  fireworks: PROVIDER_MODEL_CATALOG.fireworks.availableModels,
  nvidia: PROVIDER_MODEL_CATALOG.nvidia.availableModels,
  lmstudio: PROVIDER_MODEL_CATALOG.lmstudio.availableModels,
  "opencode-go": PROVIDER_MODEL_CATALOG["opencode-go"].availableModels,
  "opencode-zen": PROVIDER_MODEL_CATALOG["opencode-zen"].availableModels,
  "codex-cli": PROVIDER_MODEL_CATALOG["codex-cli"].availableModels,
  "aws-bedrock-proxy": PROVIDER_MODEL_CATALOG["aws-bedrock-proxy"].availableModels,
  google: PROVIDER_MODEL_CATALOG.google.availableModels,
  openai: PROVIDER_MODEL_CATALOG.openai.availableModels,
};

export function modelChoicesByProvider(): Record<ProviderName, readonly string[]> {
  return PROVIDER_MODEL_CHOICES;
}

export function userFacingProviders(): ProviderName[] {
  return (Object.keys(PROVIDER_MODEL_CATALOG) as ProviderName[])
    .filter((provider) => isUserFacingProviderEnabled(provider));
}
