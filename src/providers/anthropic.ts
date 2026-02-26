import type { Model, Api, SimpleStreamOptions } from "@mariozechner/pi-ai";

import { resolvePiModel } from "../pi/providerAdapter";
import type { AgentConfig } from "../types";

function normalizeAnthropicModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "claude-sonnet-4-6") {
    return "claude-sonnet-4-6";
  }
  return modelId;
}

/**
 * Default stream options for Anthropic models.
 *
 * Pi's `streamSimple()` handles thinking/reasoning via the `reasoning` level
 * and optional `thinkingBudgets`. These replace the AI SDK's
 * `AnthropicProviderOptions.thinking.budgetTokens`.
 */
export const DEFAULT_ANTHROPIC_STREAM_OPTIONS: SimpleStreamOptions = {
  reasoning: "high",
  thinkingBudgets: {
    high: 32_000,
  },
};

/**
 * Legacy shape preserved for config compatibility. The `providerOptions` field
 * in config.json may still reference these keys; they're mapped to pi stream
 * options at call time in the agent loop.
 */
export const DEFAULT_ANTHROPIC_PROVIDER_OPTIONS = {
  thinking: {
    type: "enabled",
    budgetTokens: 32_000,
  },
  disableParallelToolUse: true,
} as const;

export const anthropicProvider = {
  keyCandidates: ["anthropic"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }): Model<Api> => {
    return resolvePiModel("anthropic", normalizeAnthropicModelId(modelId), {
      apiKey: savedKey,
    });
  },
};
