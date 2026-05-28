import type { AgentConfig } from "../types";
import { createCodexAppServerModelAdapter } from "./modelAdapter";

export const codexCliProvider = {
  keyCandidates: [] as const,
  createModel: ({
    config,
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createCodexAppServerModelAdapter(config, modelId, savedKey),
};
