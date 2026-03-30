import type { AgentConfig } from "../types";
import { createAwsBedrockProxyModelAdapter } from "./modelAdapter";

export const awsBedrockProxyProvider = {
  keyCandidates: ["aws-bedrock-proxy"] as const,
  createModel: ({ config, modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createAwsBedrockProxyModelAdapter(config, modelId, savedKey),
};
