import { normalizeModelIdForProvider } from "../models/metadata";
import type { AgentConfig, ProviderName } from "../types";

import { anthropicProvider } from "./anthropic";
import { antigravityProvider } from "./antigravity";
import { basetenProvider } from "./baseten";
import { bedrockProvider } from "./bedrock";
import { PROVIDER_MODEL_CATALOG } from "./catalog";
import { codexCliProvider } from "./codex-cli";
import { firepassProvider, fireworksProvider } from "./fireworksInferenceProvider";
import { googleProvider } from "./google";
import { lmstudioProvider } from "./lmstudio";
import { minimaxProvider } from "./minimax";
import { nvidiaProvider } from "./nvidia";
import { openaiProvider } from "./openai";
import { opencodeGoProvider } from "./opencode-go";
import { opencodeZenProvider } from "./opencode-zen";
import { togetherProvider } from "./together";

export {
  defaultModelForProvider,
  PROVIDER_MODEL_CATALOG,
} from "./catalog";
export { DEFAULT_PROVIDER_OPTIONS } from "./providerOptions";

type ProviderRuntimeDefinition = {
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
  firepass: firepassProvider,
  nvidia: nvidiaProvider,
  lmstudio: lmstudioProvider,
  minimax: minimaxProvider,
  "opencode-go": opencodeGoProvider,
  "opencode-zen": opencodeZenProvider,
  "codex-cli": codexCliProvider,
  google: googleProvider,
  openai: openaiProvider,
  antigravity: antigravityProvider,
};

export const PROVIDERS: Record<ProviderName, ProviderDefinition> = {
  anthropic: { ...PROVIDER_RUNTIMES.anthropic, ...PROVIDER_MODEL_CATALOG.anthropic },
  bedrock: { ...PROVIDER_RUNTIMES.bedrock, ...PROVIDER_MODEL_CATALOG.bedrock },
  baseten: { ...PROVIDER_RUNTIMES.baseten, ...PROVIDER_MODEL_CATALOG.baseten },
  together: { ...PROVIDER_RUNTIMES.together, ...PROVIDER_MODEL_CATALOG.together },
  fireworks: { ...PROVIDER_RUNTIMES.fireworks, ...PROVIDER_MODEL_CATALOG.fireworks },
  firepass: { ...PROVIDER_RUNTIMES.firepass, ...PROVIDER_MODEL_CATALOG.firepass },
  nvidia: { ...PROVIDER_RUNTIMES.nvidia, ...PROVIDER_MODEL_CATALOG.nvidia },
  lmstudio: { ...PROVIDER_RUNTIMES.lmstudio, ...PROVIDER_MODEL_CATALOG.lmstudio },
  minimax: { ...PROVIDER_RUNTIMES.minimax, ...PROVIDER_MODEL_CATALOG.minimax },
  "opencode-go": { ...PROVIDER_RUNTIMES["opencode-go"], ...PROVIDER_MODEL_CATALOG["opencode-go"] },
  "opencode-zen": {
    ...PROVIDER_RUNTIMES["opencode-zen"],
    ...PROVIDER_MODEL_CATALOG["opencode-zen"],
  },
  "codex-cli": { ...PROVIDER_RUNTIMES["codex-cli"], ...PROVIDER_MODEL_CATALOG["codex-cli"] },
  google: { ...PROVIDER_RUNTIMES.google, ...PROVIDER_MODEL_CATALOG.google },
  openai: { ...PROVIDER_RUNTIMES.openai, ...PROVIDER_MODEL_CATALOG.openai },
  antigravity: { ...PROVIDER_RUNTIMES.antigravity, ...PROVIDER_MODEL_CATALOG.antigravity },
};

export function getModelForProvider(config: AgentConfig, modelId: string, savedKey?: string) {
  const normalizedModelId = normalizeModelIdForProvider(config.provider, modelId);
  return PROVIDERS[config.provider].createModel({ config, modelId: normalizedModelId, savedKey });
}

export function getProviderKeyCandidates(provider: ProviderName): readonly ProviderName[] {
  return PROVIDERS[provider].keyCandidates;
}
