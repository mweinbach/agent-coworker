import { createGeminiProvider } from "ai-sdk-provider-gemini-cli";

import type { AgentConfig } from "../types";

import { resolveGeminiCliModelSettings } from "./gemini-cli-options";

export const geminiCliProvider = {
  defaultModel: "gemini-3-flash-preview",
  keyCandidates: ["gemini-cli", "google"] as const,
  createModel: ({ config, modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) => {
    const envKey = savedKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const provider = envKey
      ? createGeminiProvider({
          authType: "api-key",
          apiKey: envKey,
        })
      : createGeminiProvider({
          authType: "oauth-personal",
        });
    return provider(modelId, resolveGeminiCliModelSettings(config));
  },
};
