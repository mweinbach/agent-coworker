import { normalizeRuntimeNameForProvider, type AgentConfig, type RuntimeName } from "../types";

import { createPiRuntime } from "./piRuntime";
import { createOpenAiResponsesRuntime } from "./openaiResponsesRuntime";
import { createGoogleInteractionsRuntime } from "./googleInteractionsRuntime";

import type { LlmRuntime } from "./types";

export function resolveRuntimeName(config: AgentConfig): RuntimeName {
  return normalizeRuntimeNameForProvider(config.provider, config.runtime);
}

export function createRuntime(config: AgentConfig): LlmRuntime {
  const runtimeName = resolveRuntimeName(config);
  switch (runtimeName) {
    case "openai-responses":
      if (config.provider !== "openai" && config.provider !== "codex-cli") {
        throw new Error(`Provider ${config.provider} does not support the OpenAI Responses runtime.`);
      }
      return createOpenAiResponsesRuntime();
    case "google-interactions":
      if (config.provider !== "google") {
        throw new Error(`Provider ${config.provider} does not support the Google Interactions runtime.`);
      }
      return createGoogleInteractionsRuntime();
    case "pi":
      return createPiRuntime();
  }
}

export * from "./types";
