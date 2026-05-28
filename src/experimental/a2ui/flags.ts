import type { AgentConfig } from "../../types";

const A2UI_EXPERIMENT_ENV = "COWORK_EXPERIMENTAL_A2UI";

export function isA2uiExperimentEnabled(env: Record<string, string | undefined> = process.env) {
  return env[A2UI_EXPERIMENT_ENV] === "1";
}

export function resolveExperimentalA2uiConfig(
  config: Pick<AgentConfig, "enableA2ui" | "featureFlags" | "experimentalFeatures">,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!isA2uiExperimentEnabled(env) && config.experimentalFeatures?.a2ui !== true) {
    return false;
  }
  if (typeof config.featureFlags?.workspace?.a2ui === "boolean") {
    return config.featureFlags.workspace.a2ui;
  }
  return config.enableA2ui === true;
}
