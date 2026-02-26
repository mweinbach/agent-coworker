import type { Model, Api, SimpleStreamOptions } from "../pi/types";

import { resolvePiModel } from "../pi/providerAdapter";
import type { AgentConfig } from "../types";

/**
 * Default stream options for OpenAI models.
 *
 * Pi's `streamSimple()` maps `reasoning: "high"` to OpenAI's
 * `reasoning_effort: "high"` automatically.
 */
export const DEFAULT_OPENAI_STREAM_OPTIONS: SimpleStreamOptions = {
  reasoning: "high",
};

/**
 * Legacy shape preserved for config compatibility.
 */
export const DEFAULT_OPENAI_PROVIDER_OPTIONS = {
  reasoningEffort: "high",
  reasoningSummary: "detailed",
  textVerbosity: "high",
} as const;

export const openaiProvider = {
  keyCandidates: ["openai"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }): Model<Api> => {
    return resolvePiModel("openai", modelId, {
      apiKey: savedKey,
    });
  },
};
