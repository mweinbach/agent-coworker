import type { ProviderName } from "../types";

export type FireworksInferenceProvider = "fireworks" | "firepass";

export type FireworksInferenceModelSpec = {
  id: string;
  name: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  pricing: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};

export const FIREWORKS_INFERENCE_BASE_URL = "https://api.fireworks.ai/inference/v1";

const FIREWORKS_INFERENCE_AUTH: Record<
  FireworksInferenceProvider,
  { envKey: string; adapterProvider: string }
> = {
  fireworks: { envKey: "FIREWORKS_API_KEY", adapterProvider: "fireworks.completions" },
  firepass: { envKey: "FIREPASS_API_KEY", adapterProvider: "firepass.completions" },
};

// Fireworks publishes per-model endpoints under accounts/fireworks/models/...; keep
// conservative limits where the vendor does not document an explicit max output.
const FIREWORKS_INFERENCE_MODELS: Record<
  FireworksInferenceProvider,
  Record<string, FireworksInferenceModelSpec>
> = {
  fireworks: {
    "accounts/fireworks/models/deepseek-v4-pro": {
      id: "accounts/fireworks/models/deepseek-v4-pro",
      name: "DeepSeek-V4-Pro",
      baseUrl: FIREWORKS_INFERENCE_BASE_URL,
      reasoning: true,
      input: ["text"],
      contextWindow: 204_800,
      maxTokens: 131_072,
      pricing: {
        input: 1.74,
        output: 3.48,
        cacheRead: 0.15,
      },
    },
    "accounts/fireworks/models/kimi-k2p6": {
      id: "accounts/fireworks/models/kimi-k2p6",
      name: "Kimi K2.6",
      baseUrl: FIREWORKS_INFERENCE_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 65_536,
      pricing: {
        input: 0.95,
        output: 4,
        cacheRead: 0.16,
      },
    },
    "accounts/fireworks/models/glm-5p1": {
      id: "accounts/fireworks/models/glm-5p1",
      name: "GLM 5.1",
      baseUrl: FIREWORKS_INFERENCE_BASE_URL,
      reasoning: true,
      input: ["text"],
      contextWindow: 204_800,
      maxTokens: 131_072,
      pricing: {
        input: 1.4,
        output: 4.4,
        cacheRead: 0.26,
      },
    },
    "accounts/fireworks/models/qwen3p6-plus": {
      id: "accounts/fireworks/models/qwen3p6-plus",
      name: "Qwen3.6 Plus",
      baseUrl: FIREWORKS_INFERENCE_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 65_536,
      pricing: {
        input: 0.5,
        output: 3,
        cacheRead: 0.1,
      },
    },
    "accounts/fireworks/models/minimax-m2p7": {
      id: "accounts/fireworks/models/minimax-m2p7",
      name: "MiniMax M2.7",
      baseUrl: FIREWORKS_INFERENCE_BASE_URL,
      reasoning: true,
      input: ["text"],
      contextWindow: 204_800,
      maxTokens: 65_536,
      pricing: {
        input: 0.3,
        output: 1.2,
        cacheRead: 0.06,
      },
    },
  },
  firepass: {
    // Kimi K2.6 Turbo serverless pricing (https://fireworks.ai/models/fireworks/kimi-k2p6).
    "accounts/fireworks/routers/kimi-k2p6-turbo": {
      id: "accounts/fireworks/routers/kimi-k2p6-turbo",
      name: "Kimi K2.6 Turbo",
      baseUrl: FIREWORKS_INFERENCE_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 65_536,
      pricing: {
        input: 0.95,
        output: 4,
        cacheRead: 0.16,
      },
    },
  },
};

export function isFireworksInferenceProvider(
  provider: ProviderName,
): provider is FireworksInferenceProvider {
  return provider === "fireworks" || provider === "firepass";
}

export function getFireworksInferenceAuthConfig(provider: FireworksInferenceProvider) {
  return FIREWORKS_INFERENCE_AUTH[provider];
}

export function getFireworksInferenceModelSpec(
  provider: FireworksInferenceProvider,
  modelId: string,
): FireworksInferenceModelSpec | null {
  return FIREWORKS_INFERENCE_MODELS[provider][modelId] ?? null;
}

export function getFireworksModelSpec(modelId: string): FireworksInferenceModelSpec | null {
  return getFireworksInferenceModelSpec("fireworks", modelId);
}

export function resolveFireworksInferenceApiKey(
  provider: FireworksInferenceProvider,
  opts: { savedKey?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const envKey = FIREWORKS_INFERENCE_AUTH[provider].envKey;
  const key = opts.savedKey?.trim() || env[envKey]?.trim();
  return key || undefined;
}

export function resolveFireworksApiKey(
  opts: { savedKey?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  return resolveFireworksInferenceApiKey("fireworks", opts);
}

export function listFireworksInferencePricingEntries(): Array<{
  key: `${FireworksInferenceProvider}:${string}`;
  pricing: FireworksInferenceModelSpec["pricing"];
}> {
  const entries: Array<{
    key: `${FireworksInferenceProvider}:${string}`;
    pricing: FireworksInferenceModelSpec["pricing"];
  }> = [];

  for (const provider of Object.keys(FIREWORKS_INFERENCE_MODELS) as FireworksInferenceProvider[]) {
    for (const [modelId, spec] of Object.entries(FIREWORKS_INFERENCE_MODELS[provider])) {
      entries.push({
        key: `${provider}:${modelId}`,
        pricing: spec.pricing,
      });
    }
  }

  return entries;
}
