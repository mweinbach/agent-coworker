import type { AgentConfig } from "../types";
import { createOpenCodeZenModelAdapter } from "./modelAdapter";

export const opencodeZenProvider = {
  keyCandidates: ["opencode-zen"] as const,
  createModel: ({
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createOpenCodeZenModelAdapter(modelId, savedKey),
};
