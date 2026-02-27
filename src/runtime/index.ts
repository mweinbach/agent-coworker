import type { AgentConfig, RuntimeName } from "../types";

import { createPiRuntime } from "./piRuntime";

import type { LlmRuntime } from "./types";

export function resolveRuntimeName(config: AgentConfig): RuntimeName {
  return config.runtime ?? "pi";
}

export function createRuntime(config: AgentConfig): LlmRuntime {
  const runtimeName = resolveRuntimeName(config);
  switch (runtimeName) {
    case "pi":
      return createPiRuntime();
  }
}

export * from "./types";
