import type { AgentConfig } from "../types";
import { createCodexAppServerModelAdapter } from "./modelAdapter";

export const DEFAULT_CODEX_CLI_PROVIDER_OPTIONS = {
  reasoningEffort: "high",
  reasoningSummary: "detailed",
  textVerbosity: "medium",
} as const;

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
