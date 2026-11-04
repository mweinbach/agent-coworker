export const COWORK_RUNTIME_BOOTSTRAP_PHASES = [
  "waiting",
  "downloading",
  "installing",
  "ready",
] as const;

export type CoworkRuntimeBootstrapProgress = {
  phase: (typeof COWORK_RUNTIME_BOOTSTRAP_PHASES)[number];
  version: string;
  transferredBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
};

export const SERVER_STARTUP_PROGRESS_TYPE = "server_startup_progress" as const;
export const COWORK_RUNTIME_STARTUP_COMPONENT = "cowork-runtime" as const;
export const SIDECAR_MANIFEST_NAME = "cowork-server-manifest.json";
