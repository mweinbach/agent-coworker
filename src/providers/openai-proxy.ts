import type { AgentConfig } from "../types";
import { createOpenAiProxyModelAdapter } from "./modelAdapter";

export const openaiProxyProvider = {
  keyCandidates: ["openai-proxy"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createOpenAiProxyModelAdapter(modelId, savedKey),
};
