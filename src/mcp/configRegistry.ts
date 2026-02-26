export { MCP_SERVERS_FILE_NAME, resolveMcpConfigPaths } from "./configPaths";
export type { MCPConfigPaths } from "./configPaths";

export type {
  MCPConfigRegistrySnapshot,
  MCPMigrationResult,
  MCPRegistryFileState,
  MCPRegistryLegacyState,
  MCPRegistryServer,
  MCPServerSource,
} from "./configRegistry/types";

export { DEFAULT_MCP_SERVERS_DOCUMENT, parseMCPServerConfig, parseMCPServersDocument } from "./configRegistry/parser";

export { loadMCPConfigRegistry } from "./configRegistry/layers";

export {
  deleteWorkspaceMCPServer,
  readWorkspaceMCPServersDocument,
  upsertWorkspaceMCPServer,
  writeWorkspaceMCPServersDocument,
} from "./configRegistry/editor";

export { migrateLegacyMCPServers } from "./configRegistry/migration";
