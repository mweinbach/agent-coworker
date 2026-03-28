type FireworksModelId =
  | "accounts/fireworks/models/minimax-m2p5"
  | "accounts/fireworks/models/glm-5"
  | "accounts/fireworks/models/kimi-k2p5"
  | "accounts/fireworks/routers/kimi-k2p5-turbo";

type FireworksModelSpec = {
  id: FireworksModelId;
  name: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  pricing: {
    input: number;
    output: number;
  };
};

const FIREWORKS_INFERENCE_BASE_URL = "https://api.fireworks.ai/inference/v1";

// Capability and pricing align with the OpenCode Zen entries for the same model families
// (MiniMax M2.5, GLM-5, Kimi K2.5). Fireworks publishes per-model endpoints under
// accounts/fireworks/models/...; keep conservative limits where the vendor does not
// document an explicit max output.
const FIREWORKS_MODEL_SPECS: Record<FireworksModelId, FireworksModelSpec> = {
  "accounts/fireworks/models/minimax-m2p5": {
    id: "accounts/fireworks/models/minimax-m2p5",
    name: "MiniMax M2.5",
    baseUrl: FIREWORKS_INFERENCE_BASE_URL,
    reasoning: true,
    input: ["text"],
    contextWindow: 204_800,
    maxTokens: 65_536,
    pricing: {
      input: 0.3,
      output: 1.2,
    },
  },
  "accounts/fireworks/models/glm-5": {
    id: "accounts/fireworks/models/glm-5",
    name: "GLM-5",
    baseUrl: FIREWORKS_INFERENCE_BASE_URL,
    reasoning: true,
    input: ["text"],
    contextWindow: 204_800,
    maxTokens: 131_072,
    pricing: {
      input: 1,
      output: 3.2,
    },
  },
  "accounts/fireworks/models/kimi-k2p5": {
    id: "accounts/fireworks/models/kimi-k2p5",
    name: "Kimi K2.5",
    baseUrl: FIREWORKS_INFERENCE_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 65_536,
    pricing: {
      input: 0.6,
      output: 3,
    },
  },
  "accounts/fireworks/routers/kimi-k2p5-turbo": {
    id: "accounts/fireworks/routers/kimi-k2p5-turbo",
    name: "Kimi K2.5 Turbo",
    baseUrl: FIREWORKS_INFERENCE_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 65_536,
    pricing: {
      input: 0.6,
      output: 3,
    },
  },
};

export function getFireworksModelSpec(modelId: string): FireworksModelSpec | null {
  return FIREWORKS_MODEL_SPECS[modelId as FireworksModelId] ?? null;
}

export function resolveFireworksApiKey(opts: {
  savedKey?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string | undefined {
  const env = opts.env ?? process.env;
  const key = opts.savedKey?.trim() || env.FIREWORKS_API_KEY?.trim();
  return key || undefined;
}
