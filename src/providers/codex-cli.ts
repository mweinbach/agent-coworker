import { codexCli, createCodexCli } from "ai-sdk-provider-codex-cli";

import type { AgentConfig } from "../types";

export const codexCliProvider = {
  defaultModel: "gpt-5.2-codex",
  keyCandidates: ["codex-cli", "openai"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) => {
    const envKey = savedKey || process.env.OPENAI_API_KEY;
    const provider = envKey
      ? createCodexCli({
          defaultSettings: {
            env: {
              OPENAI_API_KEY: envKey,
            },
          },
        })
      : codexCli;
    return provider(modelId);
  },
};
