import type { ProviderName } from "../types";

const OPENCODE_PROVIDER_NAMES = ["opencode-go", "opencode-zen"] as const;
export type OpenCodeProviderName = (typeof OPENCODE_PROVIDER_NAMES)[number];

// OpenCode Go (pay-as-you-go) serves only open / third-party models, mirrored
// from https://opencode.ai/zen/go/v1/models.
const OPENCODE_GO_AVAILABLE_MODELS = [
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "kimi-k2.6",
  "kimi-k2.5",
  "glm-5.1",
  "glm-5",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5-pro",
  "mimo-v2.5",
  "hy3-preview",
] as const;

// OpenCode Zen exposes its full catalog (first-party + open + free tiers),
// mirrored from https://opencode.ai/zen/v1/models.
const OPENCODE_ZEN_AVAILABLE_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-haiku-4-5",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex-spark",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-nano",
  "grok-build-0.1",
  "deepseek-v4-flash",
  "glm-5.1",
  "glm-5",
  "minimax-m2.7",
  "minimax-m2.5",
  "kimi-k2.6",
  "kimi-k2.5",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "qwen3.6-plus-free",
  "minimax-m3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
] as const;

// Union of every model id reachable through either provider; backs the spec map.
const OPENCODE_MODEL_IDS = [
  ...OPENCODE_ZEN_AVAILABLE_MODELS,
  // Go-only ids not present in the Zen catalog.
  "minimax-m3",
  "deepseek-v4-pro",
  "qwen3.7-max",
  "qwen3.7-plus",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5-pro",
  "mimo-v2.5",
  "hy3-preview",
] as const;
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

const OPENCODE_DEFAULT_MODEL: OpenCodeModelId = "glm-5";

// Capability limits and pricing are sourced from models.dev (the catalog
// OpenCode itself publishes). Ids absent from that catalog fall back to
// conservative text-only defaults.
const OPENCODE_MODEL_SPECS: Record<OpenCodeModelId, OpenCodeModelSpec> = {
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  "claude-opus-4-7": {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  "claude-opus-4-5": {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
  },
  "claude-opus-4-1": {
    id: "claude-opus-4-1",
    name: "Claude Opus 4.1",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32000,
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  "claude-sonnet-4-5": {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  "claude-sonnet-4": {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
  },
  "gemini-3.5-flash": {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  "gemini-3.1-pro": {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro Preview",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  "gemini-3-flash": {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  "gpt-5.5": {
    id: "gpt-5.5",
    name: "GPT-5.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  "gpt-5.5-pro": {
    id: "gpt-5.5-pro",
    name: "GPT-5.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    name: "GPT-5.4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  "gpt-5.4-pro": {
    id: "gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1050000,
    maxTokens: 128000,
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "gpt-5.4-nano": {
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "gpt-5.3-codex-spark": {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 128000,
  },
  "gpt-5.3-codex": {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "gpt-5.2": {
    id: "gpt-5.2",
    name: "GPT-5.2",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "gpt-5.2-codex": {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "gpt-5.1": {
    id: "gpt-5.1",
    name: "GPT-5.1",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "gpt-5.1-codex-max": {
    id: "gpt-5.1-codex-max",
    name: "GPT-5.1 Codex Max",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "gpt-5.1-codex": {
    id: "gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "gpt-5.1-codex-mini": {
    id: "gpt-5.1-codex-mini",
    name: "GPT-5.1 Codex Mini",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "gpt-5": {
    id: "gpt-5",
    name: "GPT-5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "gpt-5-codex": {
    id: "gpt-5-codex",
    name: "GPT-5 Codex",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "gpt-5-nano": {
    id: "gpt-5-nano",
    name: "GPT-5 Nano",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  "grok-build-0.1": {
    id: "grok-build-0.1",
    name: "Grok Build 0.1",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 256000,
  },
  "deepseek-v4-flash": {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 384000,
  },
  "glm-5.1": {
    id: "glm-5.1",
    name: "GLM-5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
    maxTokens: 131072,
  },
  "glm-5": {
    id: "glm-5",
    name: "GLM-5",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
    maxTokens: 131072,
  },
  "minimax-m2.7": {
    id: "minimax-m2.7",
    name: "MiniMax M2.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
    maxTokens: 131072,
  },
  "minimax-m2.5": {
    id: "minimax-m2.5",
    name: "MiniMax M2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
    maxTokens: 131072,
  },
  "kimi-k2.6": {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
  },
  "kimi-k2.5": {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
  },
  "qwen3.6-plus": {
    id: "qwen3.6-plus",
    name: "Qwen3.6 Plus",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
  },
  "qwen3.5-plus": {
    id: "qwen3.5-plus",
    name: "Qwen3.5 Plus",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
  },
  "big-pickle": {
    id: "big-pickle",
    name: "Big Pickle",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 32000,
  },
  "deepseek-v4-flash-free": {
    id: "deepseek-v4-flash-free",
    name: "DeepSeek V4 Flash Free",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 128000,
  },
  "mimo-v2.5-free": {
    id: "mimo-v2.5-free",
    name: "MiMo V2.5 Free",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32000,
  },
  "qwen3.6-plus-free": {
    id: "qwen3.6-plus-free",
    name: "Qwen3.6 Plus Free",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
  },
  "minimax-m3-free": {
    id: "minimax-m3-free",
    name: "MiniMax M3 Free",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32000,
  },
  "nemotron-3-ultra-free": {
    id: "nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra Free",
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  "north-mini-code-free": {
    id: "north-mini-code-free",
    name: "North Mini Code Free",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 65536,
  },
  "minimax-m3": {
    id: "minimax-m3",
    name: "MiniMax M3",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 512000,
    maxTokens: 131072,
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 384000,
  },
  "qwen3.7-max": {
    id: "qwen3.7-max",
    name: "Qwen3.7 Max",
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  "qwen3.7-plus": {
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  "mimo-v2-pro": {
    id: "mimo-v2-pro",
    name: "MiMo V2 Pro",
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 128000,
  },
  "mimo-v2-omni": {
    id: "mimo-v2-omni",
    name: "MiMo V2 Omni",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 128000,
  },
  "mimo-v2.5-pro": {
    id: "mimo-v2.5-pro",
    name: "MiMo V2.5 Pro",
    reasoning: true,
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 128000,
  },
  "mimo-v2.5": {
    id: "mimo-v2.5",
    name: "MiMo V2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  "hy3-preview": {
    id: "hy3-preview",
    name: "Hy3 Preview",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 65536,
  },
};

const OPENCODE_ZEN_MODEL_PRICING: Partial<Record<OpenCodeModelId, OpenCodeModelPricing>> = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.5-pro": { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.4-pro": { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  "gpt-5.3-codex-spark": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.1": { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex": { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5": { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  "gpt-5-codex": { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
  "grok-build-0.1": { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.03, cacheWrite: 0 },
  "glm-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "glm-5": { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
  "minimax-m2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "minimax-m2.5": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "kimi-k2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  "kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.08, cacheWrite: 0 },
  "qwen3.6-plus": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
  "qwen3.5-plus": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  "big-pickle": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "deepseek-v4-flash-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "mimo-v2.5-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "qwen3.6-plus-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "minimax-m3-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "nemotron-3-ultra-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "north-mini-code-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const OPENCODE_PROVIDER_CONFIGS: Record<OpenCodeProviderName, OpenCodeProviderConfig> = {
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
  return (
    typeof value === "string" && (OPENCODE_PROVIDER_NAMES as readonly string[]).includes(value)
  );
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
  return (getOpenCodeProviderConfig(provider).availableModels as readonly string[]).includes(
    modelId,
  );
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

export function isOpenCodeSiblingPair(
  provider: ProviderName,
  sourceProvider: ProviderName,
): provider is OpenCodeProviderName {
  return (
    isOpenCodeProviderName(provider) &&
    isOpenCodeProviderName(sourceProvider) &&
    provider !== sourceProvider
  );
}
