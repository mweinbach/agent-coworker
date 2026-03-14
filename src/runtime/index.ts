import { defaultRuntimeNameForProvider, type AgentConfig, type RuntimeName } from "../types";

import { createPiRuntime } from "./piRuntime";
import { createOpenAiResponsesRuntime } from "./openaiResponsesRuntime";

import type { LlmRuntime } from "./types";

export function resolveRuntimeName(config: AgentConfig): RuntimeName {
  if (config.runtime === "pi" && (config.provider === "openai" || config.provider === "codex-cli")) {
    return "openai-responses";
  }
  return config.runtime ?? defaultRuntimeNameForProvider(config.provider);
}

export function createRuntime(config: AgentConfig): LlmRuntime {
  const runtimeName = resolveRuntimeName(config);
  switch (runtimeName) {
    case "openai-responses":
      if (config.provider !== "openai" && config.provider !== "codex-cli") {
        throw new Error(`Provider ${config.provider} does not support the OpenAI Responses runtime.`);
      }
      return createOpenAiResponsesRuntime();
    case "pi":
      return createPiRuntime();
  }
}

export * from "./types";
