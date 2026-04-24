import { normalizeModelIdForProvider } from "../models/metadata";
import type { AgentConfig, ProviderName } from "../types";

import { anthropicProvider } from "./anthropic";
import { basetenProvider } from "./baseten";
import { bedrockProvider } from "./bedrock";
import { PROVIDER_MODEL_CATALOG } from "./catalog";
import { codexCliProvider } from "./codex-cli";
import { fireworksProvider } from "./fireworks";
import { googleProvider } from "./google";
import { lmstudioProvider } from "./lmstudio";
import { nvidiaProvider } from "./nvidia";
import { openaiProvider } from "./openai";
import { opencodeGoProvider } from "./opencode-go";
import { opencodeZenProvider } from "./opencode-zen";
import { togetherProvider } from "./together";

export {
  authorizeProviderAuth,
  callbackProviderAuth,
  listProviderAuthMethods,
  type ProviderAuthChallenge,
  type ProviderAuthMethod,
  requiresProviderAuthCode,
  resolveProviderAuthMethod,
  setProviderApiKey,
  setProviderConfig,
} from "./authRegistry";
export {
  availableModelsForProvider,
  defaultModelForProvider,
  isUserFacingProviderEnabled,
  modelChoicesByProvider,
  PROVIDER_MODEL_CATALOG,
  PROVIDER_MODEL_CHOICES,
  USER_FACING_DISABLED_PROVIDERS,
  userFacingAvailableModelsForProvider,
  userFacingProviders,
} from "./catalog";
export {
  getProviderCatalog,
  listProviderCatalogEntries,
  type ProviderCatalogEntry,
  type ProviderCatalogPayload,
} from "./connectionCatalog";
export { DEFAULT_PROVIDER_OPTIONS } from "./providerOptions";

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
  bedrock: bedrockProvider,
  baseten: basetenProvider,
  together: togetherProvider,
  fireworks: fireworksProvider,
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
  bedrock: { ...PROVIDER_RUNTIMES.bedrock, ...PROVIDER_MODEL_CATALOG.bedrock },
  baseten: { ...PROVIDER_RUNTIMES.baseten, ...PROVIDER_MODEL_CATALOG.baseten },
  together: { ...PROVIDER_RUNTIMES.together, ...PROVIDER_MODEL_CATALOG.together },
  fireworks: { ...PROVIDER_RUNTIMES.fireworks, ...PROVIDER_MODEL_CATALOG.fireworks },
  nvidia: { ...PROVIDER_RUNTIMES.nvidia, ...PROVIDER_MODEL_CATALOG.nvidia },
  lmstudio: { ...PROVIDER_RUNTIMES.lmstudio, ...PROVIDER_MODEL_CATALOG.lmstudio },
  "opencode-go": { ...PROVIDER_RUNTIMES["opencode-go"], ...PROVIDER_MODEL_CATALOG["opencode-go"] },
  "opencode-zen": {
    ...PROVIDER_RUNTIMES["opencode-zen"],
    ...PROVIDER_MODEL_CATALOG["opencode-zen"],
  },
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
