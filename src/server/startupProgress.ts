import type { CoworkRuntimeBootstrapProgress } from "../coworkRuntime/types";

export const SERVER_STARTUP_PROGRESS_TYPE = "server_startup_progress" as const;
export const COWORK_RUNTIME_STARTUP_COMPONENT = "cowork-runtime" as const;

export type CoworkRuntimeStartupProgressEvent = {
  type: typeof SERVER_STARTUP_PROGRESS_TYPE;
  component: typeof COWORK_RUNTIME_STARTUP_COMPONENT;
  progress: CoworkRuntimeBootstrapProgress;
};

export function createCoworkRuntimeStartupProgressEvent(
  progress: CoworkRuntimeBootstrapProgress,
): CoworkRuntimeStartupProgressEvent {
  return {
    type: SERVER_STARTUP_PROGRESS_TYPE,
    component: COWORK_RUNTIME_STARTUP_COMPONENT,
    progress,
  };
}
