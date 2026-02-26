import type { AgentConfig, RuntimeName } from "../types";

import { createPiRuntime } from "./piRuntime";

import type { LlmRuntime } from "./types";

export function resolveRuntimeName(config: AgentConfig): RuntimeName {
  return config.runtime ?? "pi";
}

export function createRuntime(config: AgentConfig): LlmRuntime {
  void config;
  return createPiRuntime();
}

export * from "./types";
