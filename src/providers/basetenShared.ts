type BasetenModelId = "moonshotai/Kimi-K2.5" | "zai-org/GLM-5" | "nvidia/Nemotron-120B-A12B";

type BasetenModelSpec = {
  id: BasetenModelId;
  name: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  pricing?: {
    input: number;
    output: number;
  };
};

const BASETEN_BASE_URL = "https://inference.baseten.co/v1";

const BASETEN_MODEL_SPECS: Record<BasetenModelId, BasetenModelSpec> = {
  "moonshotai/Kimi-K2.5": {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    baseUrl: BASETEN_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 131_072,
    pricing: {
      input: 0.6,
      output: 3,
    },
  },
  "zai-org/GLM-5": {
    id: "zai-org/GLM-5",
    name: "GLM-5",
    baseUrl: BASETEN_BASE_URL,
    reasoning: false,
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 65_536,
    pricing: {
      input: 0.95,
      output: 3.15,
    },
  },
  "nvidia/Nemotron-120B-A12B": {
    id: "nvidia/Nemotron-120B-A12B",
    name: "Nemotron 120B A12B",
    baseUrl: BASETEN_BASE_URL,
    reasoning: true,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 65_536,
  },
};

export function getBasetenModelSpec(modelId: string): BasetenModelSpec | null {
  return BASETEN_MODEL_SPECS[modelId as BasetenModelId] ?? null;
}

export function resolveBasetenApiKey(
  opts: { savedKey?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const key = opts.savedKey?.trim() || env.BASETEN_API_KEY?.trim();
  return key || undefined;
}
