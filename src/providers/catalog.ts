import type { ProviderName } from "../types";

type ProviderModelDefinition = {
  defaultModel: string;
  availableModels: readonly string[];
};

export const PROVIDER_MODEL_CATALOG = {
  anthropic: {
    defaultModel: "claude-opus-4-6",
    availableModels: ["claude-opus-4-6", "claude-4-5-sonnet", "claude-4-5-haiku"],
  },
  "claude-code": {
    defaultModel: "sonnet",
    availableModels: ["sonnet", "opus", "haiku"],
  },
  "codex-cli": {
    defaultModel: "gpt-5.3-codex",
    availableModels: ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.2"],
  },
  "gemini-cli": {
    defaultModel: "gemini-3-flash-preview",
    availableModels: ["gemini-3-flash-preview", "gemini-3-pro-preview"],
  },
  google: {
    defaultModel: "gemini-3-flash-preview",
    availableModels: ["gemini-3-flash-preview", "gemini-3-pro-preview"],
  },
  openai: {
    defaultModel: "gpt-5.2",
    availableModels: ["gpt-5.2", "gpt-5.2-codex", "gpt-5.1", "gpt-5-mini", "gpt-5.2-pro"],
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
  "claude-code": PROVIDER_MODEL_CATALOG["claude-code"].availableModels,
  "codex-cli": PROVIDER_MODEL_CATALOG["codex-cli"].availableModels,
  "gemini-cli": PROVIDER_MODEL_CATALOG["gemini-cli"].availableModels,
  google: PROVIDER_MODEL_CATALOG.google.availableModels,
  openai: PROVIDER_MODEL_CATALOG.openai.availableModels,
};

export function modelChoicesByProvider(): Record<ProviderName, readonly string[]> {
  return PROVIDER_MODEL_CHOICES;
}
