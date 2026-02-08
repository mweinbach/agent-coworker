import { createGoogleGenerativeAI, google } from "@ai-sdk/google";

import type { AgentConfig } from "../types";

export const googleProvider = {
  defaultModel: "gemini-3-flash-preview",
  keyCandidates: ["google"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) => {
    const provider = savedKey ? createGoogleGenerativeAI({ apiKey: savedKey }) : google;
    return provider(modelId);
  },
};
