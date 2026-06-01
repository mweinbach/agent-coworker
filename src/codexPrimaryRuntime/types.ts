export type FetchLike = typeof fetch;

export type ExtractZipArchive = (archivePath: string, destinationDir: string) => Promise<void>;

export type CodexRuntimeSkillName = "documents" | "presentations" | "spreadsheets";

export type SkillSourceSpec = {
  name: CodexRuntimeSkillName;
  pluginName: "documents" | "presentations" | "spreadsheets";
  sourceSkillName: "documents" | "presentations" | "spreadsheets";
};

export type CodexPrimaryRuntimeSkillResult = {
  name: CodexRuntimeSkillName;
  status: "installed" | "already_installed" | "missing" | "skipped";
  source?: string;
  destination?: string;
  reason?: string;
};

export type CodexPrimaryRuntimeSetupResult = {
  runtimeDir: string;
  stateFile: string;
  skills: CodexPrimaryRuntimeSkillResult[];
  archive: {
    status: "downloaded" | "skipped" | "failed";
    endpoint: string;
    extractedDir?: string;
    reason?: string;
  };
};

export type CodexPrimaryRuntimeState = {
  version: number;
  updatedAt: string;
  installedSkills: CodexRuntimeSkillName[];
};

export type EnsureCodexPrimaryRuntimeOptions = {
  homedir?: string;
  workspaceDir?: string;
  builtInSkillsDir?: string;
  globalSkillsDir?: string;
  globalPluginsDir?: string;
  skipGlobalWorkspaceToolsPlugin?: boolean;
  env?: Record<string, string | undefined>;
  bundledRuntimeDir?: string;
  fetchImpl?: FetchLike;
  extractZipArchive?: ExtractZipArchive;
  allowNetwork?: boolean;
  force?: boolean;
  log?: (line: string) => void;
};
