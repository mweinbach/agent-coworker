import type { ProviderName } from "../types";

export const OPENCODE_PROVIDER_NAMES = ["opencode-go", "opencode-zen"] as const;
export type OpenCodeProviderName = (typeof OPENCODE_PROVIDER_NAMES)[number];

export const OPENCODE_GO_AVAILABLE_MODELS = ["glm-5", "kimi-k2.5"] as const;
export const OPENCODE_ZEN_EXTRA_MODELS = [
  "nemotron-3-super-free",
  "mimo-v2-flash-free",
  "big-pickle",
  "minimax-m2.5-free",
  "minimax-m2.5",
] as const;
export const OPENCODE_ZEN_AVAILABLE_MODELS = [...OPENCODE_GO_AVAILABLE_MODELS, ...OPENCODE_ZEN_EXTRA_MODELS] as const;
export const OPENCODE_MODEL_IDS = [...OPENCODE_GO_AVAILABLE_MODELS, ...OPENCODE_ZEN_EXTRA_MODELS] as const;
export type OpenCodeModelId = (typeof OPENCODE_MODEL_IDS)[number];

export type OpenCodeModelSpec = {
  id: OpenCodeModelId;
  name: string;
  reasoning: true;
  input: readonly ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
};

export type OpenCodeModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type OpenCodeProviderConfig = {
  id: OpenCodeProviderName;
  label: string;
  adapterProvider: string;
  baseUrl: string;
  envVarName: string;
  defaultModel: OpenCodeModelId;
  availableModels: readonly OpenCodeModelId[];
};

export const OPENCODE_DEFAULT_MODEL: OpenCodeModelId = "glm-5";

// OpenCode Zen's public /models endpoint exposes ids but not full capability
// limits, so only fields confirmed by current official docs should be set
// explicitly here. Unpublished limits stay conservative.
const DEFAULT_OPENCODE_TEXT_MODEL_LIMITS = {
  reasoning: true as const,
  input: ["text"] as const,
  contextWindow: 262144,
  maxTokens: 65536,
};

export const OPENCODE_MODEL_SPECS: Record<OpenCodeModelId, OpenCodeModelSpec> = {
  "glm-5": {
    id: "glm-5",
    name: "GLM-5",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
    maxTokens: 131072,
  },
  "kimi-k2.5": {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
  },
  "nemotron-3-super-free": {
    id: "nemotron-3-super-free",
    name: "Nemotron 3 Super Free",
    ...DEFAULT_OPENCODE_TEXT_MODEL_LIMITS,
    contextWindow: 1_000_000,
  },
  "mimo-v2-flash-free": {
    id: "mimo-v2-flash-free",
    name: "Mimo V2 Flash Free",
    ...DEFAULT_OPENCODE_TEXT_MODEL_LIMITS,
    contextWindow: 256000,
  },
  "big-pickle": {
    id: "big-pickle",
    name: "Big Pickle",
    ...DEFAULT_OPENCODE_TEXT_MODEL_LIMITS,
  },
  "minimax-m2.5-free": {
    id: "minimax-m2.5-free",
    name: "MiniMax M2.5 Free",
    ...DEFAULT_OPENCODE_TEXT_MODEL_LIMITS,
    contextWindow: 204800,
  },
  "minimax-m2.5": {
    id: "minimax-m2.5",
    name: "MiniMax M2.5",
    ...DEFAULT_OPENCODE_TEXT_MODEL_LIMITS,
    contextWindow: 204800,
  },
};

const OPENCODE_ZEN_MODEL_PRICING: Partial<Record<OpenCodeModelId, OpenCodeModelPricing>> = {
  "glm-5": {
    input: 1,
    output: 3.2,
    cacheRead: 0.2,
    cacheWrite: 0,
  },
  "kimi-k2.5": {
    input: 0.6,
    output: 3,
    cacheRead: 0.08,
    cacheWrite: 0,
  },
  "nemotron-3-super-free": {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "mimo-v2-flash-free": {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "big-pickle": {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "minimax-m2.5-free": {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "minimax-m2.5": {
    input: 0.3,
    output: 1.2,
    cacheRead: 0.06,
    cacheWrite: 0.375,
  },
};

export const OPENCODE_MODEL_METADATA_NOTES: Partial<Record<OpenCodeModelId, string>> = {
  "nemotron-3-super-free": "Official NVIDIA docs publish a 1M-token context window, but not an authoritative max-output limit.",
  "mimo-v2-flash-free": "Official Xiaomi docs publish a 256k context window, but not an authoritative max-output limit.",
  "big-pickle": "OpenCode Zen currently publishes this model id and pricing, but not a public context-window or max-output spec.",
  "minimax-m2.5-free": "Official MiniMax docs publish a 204,800-token input context window, but not an authoritative max-output limit.",
  "minimax-m2.5": "Official MiniMax docs publish a 204,800-token input context window, but not an authoritative max-output limit.",
};

export const OPENCODE_PROVIDER_CONFIGS: Record<OpenCodeProviderName, OpenCodeProviderConfig> = {
  "opencode-go": {
    id: "opencode-go",
    label: "OpenCode Go",
    adapterProvider: "opencode-go.completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    envVarName: "OPENCODE_API_KEY",
    defaultModel: OPENCODE_DEFAULT_MODEL,
    availableModels: OPENCODE_GO_AVAILABLE_MODELS,
  },
  "opencode-zen": {
    id: "opencode-zen",
    label: "OpenCode Zen",
    adapterProvider: "opencode-zen.completions",
    baseUrl: "https://opencode.ai/zen/v1",
    envVarName: "OPENCODE_ZEN_API_KEY",
    defaultModel: OPENCODE_DEFAULT_MODEL,
    availableModels: OPENCODE_ZEN_AVAILABLE_MODELS,
  },
};

export function isOpenCodeProviderName(value: unknown): value is OpenCodeProviderName {
  return typeof value === "string" && (OPENCODE_PROVIDER_NAMES as readonly string[]).includes(value);
}

export function getOpenCodeProviderConfig(provider: OpenCodeProviderName): OpenCodeProviderConfig {
  return OPENCODE_PROVIDER_CONFIGS[provider];
}

export function getOpenCodeDisplayName(provider: OpenCodeProviderName): string {
  return OPENCODE_PROVIDER_CONFIGS[provider].label;
}

export function isOpenCodeModelSupportedByProvider(
  provider: OpenCodeProviderName,
  modelId: string,
): modelId is OpenCodeModelId {
  return (getOpenCodeProviderConfig(provider).availableModels as readonly string[]).includes(modelId);
}

export function getOpenCodeModelSpec(modelId: string): OpenCodeModelSpec | null {
  return OPENCODE_MODEL_SPECS[modelId as OpenCodeModelId] ?? null;
}

export function getOpenCodeModelPricing(
  provider: OpenCodeProviderName,
  modelId: string,
): OpenCodeModelPricing | null {
  if (provider !== "opencode-zen") {
    return null;
  }
  return OPENCODE_ZEN_MODEL_PRICING[modelId as OpenCodeModelId] ?? null;
}

export function resolveOpenCodeApiKey(
  provider: OpenCodeProviderName,
  opts: {
    savedKey?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string | undefined {
  const savedKey = opts.savedKey?.trim();
  if (savedKey) return savedKey;

  const envVarName = getOpenCodeProviderConfig(provider).envVarName;
  const envValue = (opts.env ?? process.env)[envVarName]?.trim();
  return envValue ? envValue : undefined;
}

export function getOpenCodeSiblingProvider(provider: OpenCodeProviderName): OpenCodeProviderName {
  return provider === "opencode-go" ? "opencode-zen" : "opencode-go";
}

export function isOpenCodeSiblingPair(
  provider: ProviderName,
  sourceProvider: ProviderName,
): provider is OpenCodeProviderName {
  return isOpenCodeProviderName(provider)
    && isOpenCodeProviderName(sourceProvider)
    && provider !== sourceProvider;
}
