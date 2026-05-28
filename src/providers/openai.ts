import type { AgentConfig } from "../types";
import { createOpenAiModelAdapter } from "./modelAdapter";

export const openaiProvider = {
  keyCandidates: ["openai"] as const,
  createModel: ({
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createOpenAiModelAdapter(modelId, savedKey),
};
