import { claudeCode, createClaudeCode } from "ai-sdk-provider-claude-code";

import type { AgentConfig } from "../types";

export const claudeCodeProvider = {
  defaultModel: "sonnet",
  keyCandidates: ["claude-code", "anthropic"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) => {
    const envKey = savedKey || process.env.ANTHROPIC_API_KEY;
    const provider = envKey
      ? createClaudeCode({
          defaultSettings: {
            env: {
              ANTHROPIC_API_KEY: envKey,
            },
          },
        })
      : claudeCode;
    return provider(modelId);
  },
};
