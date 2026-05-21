type FirepassModelId = "accounts/fireworks/routers/kimi-k2p6-turbo";

type FirepassModelSpec = {
  id: FirepassModelId;
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

const FIREPASS_INFERENCE_BASE_URL = "https://api.fireworks.ai/inference/v1";

// Kimi K2.6 Turbo serverless pricing (https://fireworks.ai/models/fireworks/kimi-k2p6).
const FIREPASS_MODEL_SPECS: Record<FirepassModelId, FirepassModelSpec> = {
  "accounts/fireworks/routers/kimi-k2p6-turbo": {
    id: "accounts/fireworks/routers/kimi-k2p6-turbo",
    name: "Kimi K2.6 Turbo",
    baseUrl: FIREPASS_INFERENCE_BASE_URL,
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
};

export function getFirepassModelSpec(modelId: string): FirepassModelSpec | null {
  return FIREPASS_MODEL_SPECS[modelId as FirepassModelId] ?? null;
}

export function resolveFirepassApiKey(
  opts: { savedKey?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const key = opts.savedKey?.trim() || env.FIREPASS_API_KEY?.trim();
  return key || undefined;
}
