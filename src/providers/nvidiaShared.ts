type NvidiaModelId = "nvidia/nemotron-3-super-120b-a12b";

type NvidiaModelSpec = {
  id: NvidiaModelId;
  name: string;
  baseUrl: string;
  reasoning: true;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsStore: boolean;
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
    maxTokensField: "max_tokens" | "max_completion_tokens";
    thinkingFormat: "openai" | "zai" | "qwen";
  };
};

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

// NVIDIA's Nemotron docs publish a 1M-token context window and route reasoning
// control through chat_template_kwargs.enable_thinking. Cowork keeps local output
// limits as metadata only; runtime request normalization strips explicit max-token
// and reasoning-budget fields so the provider controls them server-side.
const NVIDIA_MODEL_SPECS: Record<NvidiaModelId, NvidiaModelSpec> = {
  "nvidia/nemotron-3-super-120b-a12b": {
    id: "nvidia/nemotron-3-super-120b-a12b",
    name: "Nemotron 3 Super 120B A12B",
    baseUrl: NVIDIA_BASE_URL,
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "qwen",
    },
  },
};

export function getNvidiaModelSpec(modelId: string): NvidiaModelSpec | null {
  return NVIDIA_MODEL_SPECS[modelId as NvidiaModelId] ?? null;
}

export function resolveNvidiaApiKey(
  opts: { savedKey?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const key = opts.savedKey?.trim() || env.NVIDIA_API_KEY?.trim();
  return key || undefined;
}
