import type { AgentConfig } from "../types";
import { createMinimaxModelAdapter } from "./modelAdapter";

export const minimaxProvider = {
  keyCandidates: ["minimax"] as const,
  createModel: ({
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createMinimaxModelAdapter(modelId, savedKey),
};
