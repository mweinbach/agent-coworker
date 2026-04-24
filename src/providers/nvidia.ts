import type { AgentConfig } from "../types";
import { createNvidiaModelAdapter } from "./modelAdapter";

export const nvidiaProvider = {
  keyCandidates: ["nvidia"] as const,
  createModel: ({
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createNvidiaModelAdapter(modelId, savedKey),
};
