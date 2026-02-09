import type { AgentConfig, ProviderName } from "../types";

import { anthropicProvider } from "./anthropic";
import { claudeCodeProvider } from "./claude-code";
import { codexCliProvider } from "./codex-cli";
import { googleProvider } from "./google";
import { openaiProvider } from "./openai";
export { DEFAULT_PROVIDER_OPTIONS } from "./providerOptions";

export type ProviderRuntimeDefinition = {
  keyCandidates: readonly ProviderName[];
  createModel: (options: { config: AgentConfig; modelId: string; savedKey?: string }) => unknown;
};

type ProviderModelDefinition = {
  defaultModel: string;
  availableModels: readonly string[];
};

export type ProviderDefinition = {
  defaultModel: string;
  availableModels: readonly string[];
} & ProviderRuntimeDefinition;

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
    availableModels: ["gpt-5.2", "gpt-5.2-codex", "gpt-5.1", "gpt-5-mini", "gpt-5", "gpt-5.2-pro"],
  },
} as const satisfies Record<ProviderName, ProviderModelDefinition>;

const DESKTOP_BUNDLE = process.env.COWORK_DESKTOP_BUNDLE === "1";

const geminiCliProvider: ProviderRuntimeDefinition = DESKTOP_BUNDLE
  ? {
      keyCandidates: ["google"] as const,
      createModel: () => {
        throw new Error(
          "The gemini-cli provider is disabled in the desktop bundle. Connect via google/openai/anthropic instead."
        );
      },
    }
  : (await import("./gemini-cli")).geminiCliProvider;

const PROVIDER_RUNTIMES: Record<ProviderName, ProviderRuntimeDefinition> = {
  anthropic: anthropicProvider,
  "claude-code": claudeCodeProvider,
  "codex-cli": codexCliProvider,
  "gemini-cli": geminiCliProvider,
  google: googleProvider,
  openai: openaiProvider,
};

export const PROVIDERS: Record<ProviderName, ProviderDefinition> = {
  anthropic: { ...PROVIDER_RUNTIMES.anthropic, ...PROVIDER_MODEL_CATALOG.anthropic },
  "claude-code": { ...PROVIDER_RUNTIMES["claude-code"], ...PROVIDER_MODEL_CATALOG["claude-code"] },
  "codex-cli": { ...PROVIDER_RUNTIMES["codex-cli"], ...PROVIDER_MODEL_CATALOG["codex-cli"] },
  "gemini-cli": { ...PROVIDER_RUNTIMES["gemini-cli"], ...PROVIDER_MODEL_CATALOG["gemini-cli"] },
  google: { ...PROVIDER_RUNTIMES.google, ...PROVIDER_MODEL_CATALOG.google },
  openai: { ...PROVIDER_RUNTIMES.openai, ...PROVIDER_MODEL_CATALOG.openai },
};

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

export function getModelForProvider(config: AgentConfig, modelId: string, savedKey?: string) {
  return PROVIDERS[config.provider].createModel({ config, modelId, savedKey });
}

export function getProviderKeyCandidates(provider: ProviderName): readonly ProviderName[] {
  return PROVIDERS[provider].keyCandidates;
}
