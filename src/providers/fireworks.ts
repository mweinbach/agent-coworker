import type { AgentConfig } from "../types";
import { createFireworksModelAdapter } from "./modelAdapter";

export const fireworksProvider = {
  keyCandidates: ["fireworks"] as const,
  createModel: ({
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createFireworksModelAdapter(modelId, savedKey),
};
