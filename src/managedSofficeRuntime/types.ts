export type ManagedSofficeRuntimeSetupResult = {
  status: "available" | "disabled";
  runtimeEnv: Record<string, string>;
  rootDir?: string;
  shimDir?: string;
  shimPath?: string;
  helperPath?: string;
  reason?: string;
};

export type EnsureManagedSofficeRuntimeOptions = {
  homedir?: string;
  env?: Record<string, string | undefined>;
  nodePath?: string;
  log?: (line: string) => void;
};

export type ManagedSofficeRuntimeDiagnostic = {
  status: "available" | "unavailable" | "disabled";
  checkedAt: string;
  message: string;
  version?: string;
  shimPath?: string;
  resolvedPath?: string;
  rootDir?: string;
  smoke?: {
    ok: boolean;
    durationMs: number;
    outputPath?: string;
    sizeBytes?: number;
    error?: string;
  };
};

export type ProcessCapture = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};
