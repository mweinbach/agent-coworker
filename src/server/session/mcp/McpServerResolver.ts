import type { MCPRegistryServer, MCPServerSource } from "../../../mcp/configRegistry";
import type { SessionContext } from "../SessionContext";
import type { McpServerLookup } from "./McpServerLookup";

export class McpServerResolver {
  constructor(private readonly context: SessionContext) {}

  async resolveByName(
    nameRaw: string,
    lookup?: McpServerLookup | MCPServerSource,
  ): Promise<MCPRegistryServer | null> {
    return await this.context.getMcpServerByName(
      nameRaw,
      typeof lookup === "string" ? { source: lookup } : lookup,
    );
  }
}
