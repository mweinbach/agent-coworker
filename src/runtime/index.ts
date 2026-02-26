import type { AgentConfig, RuntimeName } from "../types";

import { createAiSdkRuntime } from "./aiSdkRuntime";
import { createPiRuntime } from "./piRuntime";

import type { AiSdkRuntimeDeps } from "./aiSdkRuntime";
import type { LlmRuntime } from "./types";

export type RuntimeFactoryOptions = {
  forceRuntime?: RuntimeName;
  aiSdkDeps?: Partial<AiSdkRuntimeDeps>;
};

export function resolveRuntimeName(config: AgentConfig, forceRuntime?: RuntimeName): RuntimeName {
  if (forceRuntime) return forceRuntime;
  return config.runtime ?? "pi";
}

export function createRuntime(config: AgentConfig, options: RuntimeFactoryOptions = {}): LlmRuntime {
  const runtime = resolveRuntimeName(config, options.forceRuntime);
  if (runtime === "ai-sdk") {
    return createAiSdkRuntime(options.aiSdkDeps);
  }
  return createPiRuntime();
}

export * from "./types";
export type { AiSdkRuntimeDeps } from "./aiSdkRuntime";
