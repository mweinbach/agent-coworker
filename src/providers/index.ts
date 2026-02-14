import type { AgentConfig, LegacyProviderName, ProviderName } from "../types";

import { anthropicProvider } from "./anthropic";
import { claudeCodeProvider } from "./claude-code";
import { PROVIDER_MODEL_CATALOG } from "./catalog";
import { codexCliProvider } from "./codex-cli";
import { googleProvider } from "./google";
import { openaiProvider } from "./openai";
export { DEFAULT_PROVIDER_OPTIONS } from "./providerOptions";
export {
  PROVIDER_MODEL_CATALOG,
  PROVIDER_MODEL_CHOICES,
  availableModelsForProvider,
  defaultModelForProvider,
  modelChoicesByProvider,
} from "./catalog";

export type ProviderRuntimeDefinition = {
  keyCandidates: readonly (ProviderName | LegacyProviderName)[];
  createModel: (options: { config: AgentConfig; modelId: string; savedKey?: string }) => unknown;
};

export type ProviderDefinition = {
  defaultModel: string;
  availableModels: readonly string[];
} & ProviderRuntimeDefinition;

const PROVIDER_RUNTIMES: Record<ProviderName, ProviderRuntimeDefinition> = {
  anthropic: anthropicProvider,
  "claude-code": claudeCodeProvider,
  "codex-cli": codexCliProvider,
  google: googleProvider,
  openai: openaiProvider,
};

export const PROVIDERS: Record<ProviderName, ProviderDefinition> = {
  anthropic: { ...PROVIDER_RUNTIMES.anthropic, ...PROVIDER_MODEL_CATALOG.anthropic },
  "claude-code": { ...PROVIDER_RUNTIMES["claude-code"], ...PROVIDER_MODEL_CATALOG["claude-code"] },
  "codex-cli": { ...PROVIDER_RUNTIMES["codex-cli"], ...PROVIDER_MODEL_CATALOG["codex-cli"] },
  google: { ...PROVIDER_RUNTIMES.google, ...PROVIDER_MODEL_CATALOG.google },
  openai: { ...PROVIDER_RUNTIMES.openai, ...PROVIDER_MODEL_CATALOG.openai },
};

export function getModelForProvider(config: AgentConfig, modelId: string, savedKey?: string) {
  return PROVIDERS[config.provider].createModel({ config, modelId, savedKey });
}

export function getProviderKeyCandidates(provider: ProviderName): readonly (ProviderName | LegacyProviderName)[] {
  return PROVIDERS[provider].keyCandidates;
}
