import type { Model, Api, SimpleStreamOptions } from "../pi/types";

import { resolvePiModel } from "../pi/providerAdapter";
import type { AgentConfig } from "../types";

/**
 * Default stream options for Google models.
 *
 * Pi's `streamSimple()` maps `reasoning: "high"` to Google's
 * `thinkingConfig.thinkingLevel` and `includeThoughts: true` automatically.
 */
export const DEFAULT_GOOGLE_STREAM_OPTIONS: SimpleStreamOptions = {
  reasoning: "high",
};

/**
 * Legacy shape preserved for config compatibility.
 */
export const DEFAULT_GOOGLE_PROVIDER_OPTIONS = {
  thinkingConfig: {
    includeThoughts: true,
    thinkingLevel: "high",
  },
} as const;

export const googleProvider = {
  keyCandidates: ["google"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }): Model<Api> => {
    return resolvePiModel("google", modelId, {
      apiKey: savedKey,
    });
  },
};
