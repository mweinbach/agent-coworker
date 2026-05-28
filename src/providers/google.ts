import type { AgentConfig } from "../types";
import { createGoogleModelAdapter } from "./modelAdapter";

export const googleProvider = {
  keyCandidates: ["google"] as const,
  createModel: ({
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createGoogleModelAdapter(modelId, savedKey),
};
