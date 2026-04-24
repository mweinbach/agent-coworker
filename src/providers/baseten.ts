import type { AgentConfig } from "../types";
import { createBasetenModelAdapter } from "./modelAdapter";

export const basetenProvider = {
  keyCandidates: ["baseten"] as const,
  createModel: ({
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createBasetenModelAdapter(modelId, savedKey),
};
