import type { AgentConfig } from "../types";
import { createAntigravityModelAdapter } from "./modelAdapter";

export const antigravityProvider = {
  keyCandidates: ["antigravity", "google"] as const,
  createModel: ({
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createAntigravityModelAdapter(modelId, savedKey),
};
