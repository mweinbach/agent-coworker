import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "../types";

export const MCP_SERVERS_FILE_NAME = "mcp-servers.json";

export interface MCPConfigPaths {
  workspaceRoot: string;
  workspaceCoworkDir: string;
  workspaceConfigFile: string;
  userCoworkDir: string;
  userConfigDir: string;
  userConfigFile: string;
  systemConfigFile: string;
  workspaceLegacyFile: string;
  userLegacyFile: string;
  workspaceAuthFile: string;
  userAuthFile: string;
}

export function resolveMcpConfigPaths(config: AgentConfig): MCPConfigPaths {
  const workspaceRoot = path.dirname(config.projectAgentDir);
  const userHome = config.userAgentDir ? path.dirname(config.userAgentDir) : os.homedir();

  const workspaceCoworkDir = path.join(workspaceRoot, ".cowork");
  const userCoworkDir = path.join(userHome, ".cowork");

  return {
    workspaceRoot,
    workspaceCoworkDir,
    workspaceConfigFile: path.join(workspaceCoworkDir, MCP_SERVERS_FILE_NAME),
    userCoworkDir,
    userConfigDir: path.join(userCoworkDir, "config"),
    userConfigFile: path.join(userCoworkDir, "config", MCP_SERVERS_FILE_NAME),
    systemConfigFile: path.join(config.builtInConfigDir, MCP_SERVERS_FILE_NAME),
    workspaceLegacyFile: path.join(config.projectAgentDir, MCP_SERVERS_FILE_NAME),
    userLegacyFile: path.join(config.userAgentDir, MCP_SERVERS_FILE_NAME),
    workspaceAuthFile: path.join(workspaceCoworkDir, "auth", "mcp-credentials.json"),
    userAuthFile: path.join(userCoworkDir, "auth", "mcp-credentials.json"),
  };
}
