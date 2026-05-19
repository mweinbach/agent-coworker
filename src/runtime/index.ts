import { createRequire } from "node:module";

import { type AgentConfig, normalizeRuntimeNameForProvider, type RuntimeName } from "../types";

import type { LlmRuntime } from "./types";

const requireRuntime = createRequire(import.meta.url);

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
      return (
        requireRuntime("./openaiResponsesRuntime.ts") as typeof import("./openaiResponsesRuntime")
      ).createOpenAiResponsesRuntime();
    case "codex-app-server":
      if (config.provider !== "codex-cli") {
        throw new Error(
          `Provider ${config.provider} does not support the Codex app-server runtime.`,
        );
      }
      return (
        requireRuntime("./codexAppServerRuntime.ts") as typeof import("./codexAppServerRuntime")
      ).createCodexAppServerRuntime();
    case "cursor-sdk":
      if (config.provider !== "cursor-agent") {
        throw new Error(`Provider ${config.provider} does not support the Cursor SDK runtime.`);
      }
      return (
        requireRuntime("./cursorSdkRuntime.ts") as typeof import("./cursorSdkRuntime")
      ).createCursorSdkRuntime();
    case "google-interactions":
      if (config.provider !== "google") {
        throw new Error(
          `Provider ${config.provider} does not support the Google Interactions runtime.`,
        );
      }
      return (
        requireRuntime(
          "./googleInteractionsRuntime.ts",
        ) as typeof import("./googleInteractionsRuntime")
      ).createGoogleInteractionsRuntime();
    case "pi":
      return (requireRuntime("./piRuntime.ts") as typeof import("./piRuntime")).createPiRuntime();
  }
}

export * from "./types";
