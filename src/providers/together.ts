import type { AgentConfig } from "../types";
import { createTogetherModelAdapter } from "./modelAdapter";

export const togetherProvider = {
  keyCandidates: ["together"] as const,
  createModel: ({
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createTogetherModelAdapter(modelId, savedKey),
};
