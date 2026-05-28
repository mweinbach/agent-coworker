import type { AgentConfig } from "../../types";

const OPENAI_NATIVE_CONNECTORS_EXPERIMENT_ENV =
  "COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS";

export function isOpenAiNativeConnectorsExperimentEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[OPENAI_NATIVE_CONNECTORS_EXPERIMENT_ENV] === "1";
}

export function resolveOpenAiNativeConnectorsConfig(
  config: Pick<AgentConfig, "experimentalFeatures">,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    config.experimentalFeatures?.openAiNativeConnectors === true ||
    isOpenAiNativeConnectorsExperimentEnabled(env)
  );
}
