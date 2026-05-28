import type { AgentConfig } from "../types";
import { createAnthropicModelAdapter } from "./modelAdapter";

function normalizeAnthropicModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "claude-sonnet-4-6") {
    return "claude-sonnet-4-6";
  }
  return modelId;
}

export const anthropicProvider = {
  keyCandidates: ["anthropic"] as const,
  createModel: ({
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createAnthropicModelAdapter(normalizeAnthropicModelId(modelId), savedKey),
};
