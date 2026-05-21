import type { AgentConfig } from "../types";
import { createFirepassModelAdapter } from "./modelAdapter";

export const firepassProvider = {
  keyCandidates: ["firepass"] as const,
  createModel: ({
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createFirepassModelAdapter(modelId, savedKey),
};
