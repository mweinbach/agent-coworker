import type { AgentConfig } from "../types";

/**
 * Resolve whether the Workflow feature is enabled for the given config.
 *
 * Mirrors `resolveTasksFeatureEnabled` (`src/server/tasks/flags.ts`): the boolean
 * is materialized in `loadConfig` (`config.workflowsEnabled`) from the `workflows`
 * feature flag, so packaged builds already ignore local config overrides. This is
 * the single read point used by `createTools`/`listSessionToolNames`.
 */
export function resolveWorkflowsFeatureEnabled(
  config: Pick<AgentConfig, "workflowsEnabled">,
): boolean {
  return config.workflowsEnabled === true;
}
