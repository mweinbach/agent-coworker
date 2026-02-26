import type { MCPServerConfig } from "../../types";

export type MCPServerSource = "workspace" | "user" | "system" | "workspace_legacy" | "user_legacy";

export interface MCPRegistryServer extends MCPServerConfig {
  source: MCPServerSource;
  inherited: boolean;
}

export interface MCPRegistryLegacyState {
  workspace: {
    path: string;
    exists: boolean;
  };
  user: {
    path: string;
    exists: boolean;
  };
}

export interface MCPRegistryFileState {
  source: MCPServerSource;
  path: string;
  exists: boolean;
  editable: boolean;
  legacy: boolean;
  parseError?: string;
  serverCount: number;
}

export interface MCPConfigRegistrySnapshot {
  servers: MCPRegistryServer[];
  files: MCPRegistryFileState[];
  legacy: MCPRegistryLegacyState;
  warnings: string[];
}

export interface MCPMigrationResult {
  scope: "workspace" | "user";
  sourcePath: string;
  targetPath: string;
  archivedPath: string | null;
  imported: number;
  skippedConflicts: number;
}
