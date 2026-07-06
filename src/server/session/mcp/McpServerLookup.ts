import type { MCPRegistryServer, MCPServerSource } from "../../../mcp/configRegistry";

export type McpServerLookup = {
  source?: MCPServerSource;
  pluginId?: string;
  pluginScope?: MCPRegistryServer["pluginScope"];
};

export function mcpServerLookupFromServer(
  server: Pick<MCPRegistryServer, "source" | "pluginId" | "pluginScope">,
): McpServerLookup {
  return {
    source: server.source,
    ...(server.pluginId ? { pluginId: server.pluginId } : {}),
    ...(server.pluginScope ? { pluginScope: server.pluginScope } : {}),
  };
}
