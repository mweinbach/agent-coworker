import { createNvidiaModelAdapter } from "./modelAdapter";
import type { AgentConfig } from "../types";

export const nvidiaProvider = {
  keyCandidates: ["nvidia"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createNvidiaModelAdapter(modelId, savedKey),
};
