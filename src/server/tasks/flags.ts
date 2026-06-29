import type { AgentConfig } from "../../types";

/**
 * Resolve whether the durable Tasks feature is enabled for the given config.
 *
 * The boolean is materialized in `loadConfig` (`config.tasksEnabled`) from the
 * `tasks` feature flag, so packaged builds already ignore local config overrides
 * (see `resolveFeatureFlags`). This helper is the single read point used by the
 * tool layer (`createTools`/`listSessionToolNames`/`createTask`) and the
 * `task/*` route registration.
 */
export function resolveTasksFeatureEnabled(config: Pick<AgentConfig, "tasksEnabled">): boolean {
  return config.tasksEnabled === true;
}
