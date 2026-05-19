import type { AgentConfig } from "../types";
import { createCursorAgentModelAdapter } from "./modelAdapter";

export const DEFAULT_CURSOR_AGENT_PROVIDER_OPTIONS = {
  thinking: "high",
} as const;

export const cursorAgentProvider = {
  keyCandidates: ["cursor-agent"] as const,
  createModel: ({
    config,
    modelId,
    savedKey,
  }: {
    config: AgentConfig;
    modelId: string;
    savedKey?: string;
  }) => createCursorAgentModelAdapter(config, modelId, savedKey),
};
