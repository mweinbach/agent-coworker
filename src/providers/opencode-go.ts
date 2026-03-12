import type { AgentConfig } from "../types";
import { createOpenCodeGoModelAdapter } from "./modelAdapter";

export const opencodeGoProvider = {
  keyCandidates: ["opencode-go"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createOpenCodeGoModelAdapter(modelId, savedKey),
};
