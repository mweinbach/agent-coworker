import type { MCPServerConfig, PluginScope } from "../../types";

export type MCPServerSource =
  | "workspace"
  | "user"
  | "system"
  | "workspace_legacy"
  | "user_legacy"
  | "plugin";

export interface MCPRegistryServer extends MCPServerConfig {
  source: MCPServerSource;
  inherited: boolean;
  pluginId?: string;
  pluginName?: string;
  pluginDisplayName?: string;
  pluginScope?: PluginScope;
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
  pluginId?: string;
  pluginName?: string;
  pluginDisplayName?: string;
  pluginScope?: PluginScope;
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
