import type { AgentConfig, ProviderName } from "../types";
import { normalizeModelIdForProvider } from "../models/metadata";

import { anthropicProvider } from "./anthropic";
import { basetenProvider } from "./baseten";
import { PROVIDER_MODEL_CATALOG } from "./catalog";
import { codexCliProvider } from "./codex-cli";
import { googleProvider } from "./google";
import { lmstudioProvider } from "./lmstudio";
import { nvidiaProvider } from "./nvidia";
import { opencodeGoProvider } from "./opencode-go";
import { opencodeZenProvider } from "./opencode-zen";
import { openaiProvider } from "./openai";
import { togetherProvider } from "./together";
export { DEFAULT_PROVIDER_OPTIONS } from "./providerOptions";
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
  isUserFacingProviderEnabled,
  modelChoicesByProvider,
  USER_FACING_DISABLED_PROVIDERS,
  userFacingAvailableModelsForProvider,
  userFacingProviders,
} from "./catalog";
export { getProviderCatalog, listProviderCatalogEntries, type ProviderCatalogEntry, type ProviderCatalogPayload } from "./connectionCatalog";

export type ProviderRuntimeDefinition = {
  keyCandidates: readonly ProviderName[];
  createModel: (options: { config: AgentConfig; modelId: string; savedKey?: string }) => unknown;
};

export type ProviderDefinition = {
  defaultModel: string;
  availableModels: readonly string[];
} & ProviderRuntimeDefinition;

const PROVIDER_RUNTIMES: Record<ProviderName, ProviderRuntimeDefinition> = {
  anthropic: anthropicProvider,
  baseten: basetenProvider,
  together: togetherProvider,
  nvidia: nvidiaProvider,
  lmstudio: lmstudioProvider,
  "opencode-go": opencodeGoProvider,
  "opencode-zen": opencodeZenProvider,
  "codex-cli": codexCliProvider,
  google: googleProvider,
  openai: openaiProvider,
};

export const PROVIDERS: Record<ProviderName, ProviderDefinition> = {
  anthropic: { ...PROVIDER_RUNTIMES.anthropic, ...PROVIDER_MODEL_CATALOG.anthropic },
  baseten: { ...PROVIDER_RUNTIMES.baseten, ...PROVIDER_MODEL_CATALOG.baseten },
  together: { ...PROVIDER_RUNTIMES.together, ...PROVIDER_MODEL_CATALOG.together },
  nvidia: { ...PROVIDER_RUNTIMES.nvidia, ...PROVIDER_MODEL_CATALOG.nvidia },
  lmstudio: { ...PROVIDER_RUNTIMES.lmstudio, ...PROVIDER_MODEL_CATALOG.lmstudio },
  "opencode-go": { ...PROVIDER_RUNTIMES["opencode-go"], ...PROVIDER_MODEL_CATALOG["opencode-go"] },
  "opencode-zen": { ...PROVIDER_RUNTIMES["opencode-zen"], ...PROVIDER_MODEL_CATALOG["opencode-zen"] },
  "codex-cli": { ...PROVIDER_RUNTIMES["codex-cli"], ...PROVIDER_MODEL_CATALOG["codex-cli"] },
  google: { ...PROVIDER_RUNTIMES.google, ...PROVIDER_MODEL_CATALOG.google },
  openai: { ...PROVIDER_RUNTIMES.openai, ...PROVIDER_MODEL_CATALOG.openai },
};

export function getModelForProvider(config: AgentConfig, modelId: string, savedKey?: string) {
  const normalizedModelId = normalizeModelIdForProvider(config.provider, modelId);
  return PROVIDERS[config.provider].createModel({ config, modelId: normalizedModelId, savedKey });
}

export function getProviderKeyCandidates(provider: ProviderName): readonly ProviderName[] {
  return PROVIDERS[provider].keyCandidates;
}
