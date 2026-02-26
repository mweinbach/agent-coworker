import type { AgentConfig } from "../types";
import { createCodexCliModelAdapter } from "./modelAdapter";

export const DEFAULT_CODEX_CLI_PROVIDER_OPTIONS = {
  reasoningEffort: "high",
  reasoningSummary: "detailed",
  textVerbosity: "high",
} as const;

export const codexCliProvider = {
  keyCandidates: ["codex-cli", "openai"] as const,
  createModel: ({ config, modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) =>
    createCodexCliModelAdapter(config, modelId, savedKey),
};
