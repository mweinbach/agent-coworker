type TogetherModelId = "moonshotai/Kimi-K2.5" | "Qwen/Qwen3.5-397B-A17B" | "zai-org/GLM-5";

type TogetherModelSpec = {
  id: TogetherModelId;
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

const TOGETHER_BASE_URL = "https://api.together.xyz/v1";

// Together's serverless model catalog publishes pricing and context windows for these
// model IDs, but not a consistent explicit max-output limit across the set. Keep the
// local maxTokens ceiling conservative rather than over-claiming undocumented limits.
const TOGETHER_MODEL_SPECS: Record<TogetherModelId, TogetherModelSpec> = {
  "moonshotai/Kimi-K2.5": {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    baseUrl: TOGETHER_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 65_536,
    pricing: {
      input: 0.5,
      output: 2.8,
    },
  },
  "Qwen/Qwen3.5-397B-A17B": {
    id: "Qwen/Qwen3.5-397B-A17B",
    name: "Qwen 3.5 397B A17B",
    baseUrl: TOGETHER_BASE_URL,
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 65_536,
    pricing: {
      input: 0.6,
      output: 3.6,
    },
  },
  "zai-org/GLM-5": {
    id: "zai-org/GLM-5",
    name: "GLM-5",
    baseUrl: TOGETHER_BASE_URL,
    reasoning: false,
    input: ["text"],
    contextWindow: 202_752,
    maxTokens: 65_536,
    pricing: {
      input: 1,
      output: 3.2,
    },
  },
};

export function getTogetherModelSpec(modelId: string): TogetherModelSpec | null {
  return TOGETHER_MODEL_SPECS[modelId as TogetherModelId] ?? null;
}

export function resolveTogetherApiKey(
  opts: { savedKey?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const key = opts.savedKey?.trim() || env.TOGETHER_API_KEY?.trim();
  return key || undefined;
}
