import type { AgentConfig } from "../types";
import { createBedrockModelAdapter } from "./modelAdapter";

export const bedrockProvider = {
  keyCandidates: ["bedrock"] as const,
  createModel: ({ config, modelId }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createBedrockModelAdapter(config, modelId),
};
