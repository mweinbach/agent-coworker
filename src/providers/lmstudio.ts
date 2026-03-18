import type { AgentConfig } from "../types";
import { createLmStudioModelAdapter } from "./modelAdapter";

export const lmstudioProvider = {
  keyCandidates: ["lmstudio"] as const,
  createModel: ({ config, modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createLmStudioModelAdapter(config, modelId, savedKey),
};
