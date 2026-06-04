export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_ADAPTER_PROVIDER = "minimax.completions";
export const MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY";

const MINIMAX_MODEL_IDS = ["MiniMax-M3"] as const;
export type MiniMaxModelId = (typeof MINIMAX_MODEL_IDS)[number];

export type MiniMaxModelSpec = {
  id: MiniMaxModelId;
  name: string;
  baseUrl: string;
  reasoning: true;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  pricing: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

export const MINIMAX_DEFAULT_MODEL: MiniMaxModelId = "MiniMax-M3";

// MiniMax publishes a 1M-token context window for M3 with a 512K guaranteed floor
// and a 524,288 max output cap. The OpenAI-compatible endpoint uses
// `max_completion_tokens` (legacy `max_tokens` is deprecated) and routes reasoning
// via `thinking: { type: "adaptive" }` on the wire; pi-ai's openai-completions
// adapter handles that through its `thinkingFormat: "openai"` compat field.
const MINIMAX_MODEL_SPECS: Record<MiniMaxModelId, MiniMaxModelSpec> = {
  "MiniMax-M3": {
    id: "MiniMax-M3",
    name: "MiniMax M3",
    baseUrl: MINIMAX_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 524_288,
    pricing: {
      input: 0.6,
      output: 2.4,
      cacheRead: 0.12,
      cacheWrite: 0,
    },
  },
};

export function isMiniMaxModelId(value: unknown): value is MiniMaxModelId {
  return typeof value === "string" && (MINIMAX_MODEL_IDS as readonly string[]).includes(value);
}

export function getMinimaxModelSpec(modelId: string): MiniMaxModelSpec | null {
  return MINIMAX_MODEL_SPECS[modelId as MiniMaxModelId] ?? null;
}

export function resolveMinimaxApiKey(
  opts: { savedKey?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const key = opts.savedKey?.trim() || env[MINIMAX_API_KEY_ENV]?.trim();
  return key || undefined;
}
