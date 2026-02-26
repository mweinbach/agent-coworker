import type { Model, Api } from "@mariozechner/pi-ai";

import type { AgentConfig, ProviderName } from "../types";

import { anthropicProvider } from "./anthropic";
import { PROVIDER_MODEL_CATALOG } from "./catalog";
import { codexCliProvider } from "./codex-cli";
import { googleProvider } from "./google";
import { openaiProvider } from "./openai";
export { DEFAULT_PROVIDER_OPTIONS, DEFAULT_STREAM_OPTIONS } from "./providerOptions";
export {
  authorizeProviderAuth,
  callbackProviderAuth,
  listProviderAuthMethods,
  requiresProviderAuthCode,
  resolveProviderAuthMethod,
  setProviderApiKey,
  type ProviderAuthChallenge,
  type ProviderAuthMethod,
} from "./authRegistry";
export {
  PROVIDER_MODEL_CATALOG,
  PROVIDER_MODEL_CHOICES,
  availableModelsForProvider,
  defaultModelForProvider,
  modelChoicesByProvider,
} from "./catalog";
export { getProviderCatalog, listProviderCatalogEntries, type ProviderCatalogEntry, type ProviderCatalogPayload } from "./connectionCatalog";

export type ProviderRuntimeDefinition = {
  keyCandidates: readonly ProviderName[];
  createModel: (options: { config: AgentConfig; modelId: string; savedKey?: string }) => Model<Api>;
};

export type ProviderDefinition = {
  defaultModel: string;
  availableModels: readonly string[];
} & ProviderRuntimeDefinition;

const PROVIDER_RUNTIMES: Record<ProviderName, ProviderRuntimeDefinition> = {
  anthropic: anthropicProvider,
  "codex-cli": codexCliProvider,
  google: googleProvider,
  openai: openaiProvider,
};

export const PROVIDERS: Record<ProviderName, ProviderDefinition> = {
  anthropic: { ...PROVIDER_RUNTIMES.anthropic, ...PROVIDER_MODEL_CATALOG.anthropic },
  "codex-cli": { ...PROVIDER_RUNTIMES["codex-cli"], ...PROVIDER_MODEL_CATALOG["codex-cli"] },
  google: { ...PROVIDER_RUNTIMES.google, ...PROVIDER_MODEL_CATALOG.google },
  openai: { ...PROVIDER_RUNTIMES.openai, ...PROVIDER_MODEL_CATALOG.openai },
};

export function getModelForProvider(config: AgentConfig, modelId: string, savedKey?: string): Model<Api> {
  return PROVIDERS[config.provider].createModel({ config, modelId, savedKey });
}

export function getProviderKeyCandidates(provider: ProviderName): readonly ProviderName[] {
  return PROVIDERS[provider].keyCandidates;
}
