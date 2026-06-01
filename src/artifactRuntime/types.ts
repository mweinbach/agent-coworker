export type FetchLike = typeof fetch;

export type ExtractArchive = (archivePath: string, destinationDir: string) => Promise<void>;

export type ArtifactRuntimeSetupResult = {
  cacheDir: string;
  stateFile: string;
  runtimeEnv: Record<string, string>;
  runtime: {
    status: "available" | "missing";
    source?: string;
    nodePath?: string;
    pythonPath?: string;
    nodeModulesPath?: string;
  };
  artifactTool: {
    status: "available" | "missing";
    source?: string;
    reason?: string;
  };
  migration: {
    status: "migrated" | "skipped";
    source?: string;
  };
  archive: {
    status: "downloaded" | "skipped" | "failed";
    endpoint?: string;
    extractedDir?: string;
    reason?: string;
  };
};

export type ArtifactRuntimeState = {
  version: number;
  updatedAt: string;
  runtimeSource?: string;
  artifactSource?: string;
  migratedFrom?: string;
};

export type EnsureArtifactRuntimeOptions = {
  homedir?: string;
  env?: Record<string, string | undefined>;
  bundledRuntimeDir?: string;
  archiveUrl?: string;
  fetchImpl?: FetchLike;
  extractArchive?: ExtractArchive;
  allowNetwork?: boolean;
  force?: boolean;
  log?: (line: string) => void;
};
