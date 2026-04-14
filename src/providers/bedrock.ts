import { createBedrockModelAdapter } from "./modelAdapter";
import type { AgentConfig } from "../types";

export const bedrockProvider = {
  keyCandidates: ["bedrock"] as const,
  createModel: ({ config, modelId }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createBedrockModelAdapter(config, modelId),
};
