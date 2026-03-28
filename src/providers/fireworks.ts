import { createFireworksModelAdapter } from "./modelAdapter";
import type { AgentConfig } from "../types";

export const fireworksProvider = {
  keyCandidates: ["fireworks"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createFireworksModelAdapter(modelId, savedKey),
};
