import { anthropic, createAnthropic } from "@ai-sdk/anthropic";

import type { AgentConfig } from "../types";

export const anthropicProvider = {
  defaultModel: "claude-opus-4-6",
  keyCandidates: ["anthropic"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) => {
    const provider = savedKey ? createAnthropic({ apiKey: savedKey }) : anthropic;
    return provider(modelId);
  },
};
