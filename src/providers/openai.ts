import { createOpenAI, openai } from "@ai-sdk/openai";

import type { AgentConfig } from "../types";

export const openaiProvider = {
  defaultModel: "gpt-5.2",
  keyCandidates: ["openai"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) => {
    const provider = savedKey ? createOpenAI({ apiKey: savedKey }) : openai;
    return provider(modelId);
  },
};
