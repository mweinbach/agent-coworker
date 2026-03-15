import { createTogetherModelAdapter } from "./modelAdapter";
import type { AgentConfig } from "../types";

export const togetherProvider = {
  keyCandidates: ["together"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createTogetherModelAdapter(modelId, savedKey),
};
