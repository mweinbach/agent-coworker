import { type AgentConfig, normalizeRuntimeNameForProvider, type RuntimeName } from "../types";
import { createCodexAppServerRuntime } from "./codexAppServerRuntime";
import { createGoogleInteractionsRuntime } from "./googleInteractionsRuntime";
import { createOpenAiResponsesRuntime } from "./openaiResponsesRuntime";
import { createPiRuntime } from "./piRuntime";

import type { LlmRuntime } from "./types";

export function resolveRuntimeName(config: AgentConfig): RuntimeName {
  return normalizeRuntimeNameForProvider(config.provider, config.runtime);
}

export function createRuntime(config: AgentConfig): LlmRuntime {
  const runtimeName = resolveRuntimeName(config);
  switch (runtimeName) {
    case "openai-responses":
      if (config.provider !== "openai") {
        throw new Error(
          `Provider ${config.provider} does not support the OpenAI Responses runtime.`,
        );
      }
      return createOpenAiResponsesRuntime();
    case "codex-app-server":
      if (config.provider !== "codex-cli") {
        throw new Error(
          `Provider ${config.provider} does not support the Codex app-server runtime.`,
        );
      }
      return createCodexAppServerRuntime();
    case "google-interactions":
      if (config.provider !== "google") {
        throw new Error(
          `Provider ${config.provider} does not support the Google Interactions runtime.`,
        );
      }
      return createGoogleInteractionsRuntime();
    case "pi":
      return createPiRuntime();
  }
}

export * from "./types";
