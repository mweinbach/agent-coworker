import { loadMCPConfigRegistry, type MCPRegistryServer } from "../../../mcp/configRegistry";
import type { SessionContext } from "../SessionContext";

export class McpServerResolver {
  constructor(private readonly context: SessionContext) {}

  async resolveByName(nameRaw: string): Promise<MCPRegistryServer | null> {
    if (this.context.getMcpServerByName) {
      return await this.context.getMcpServerByName(nameRaw);
    }
    return await this.getByName(nameRaw);
  }

  private async getByName(nameRaw: string): Promise<MCPRegistryServer | null> {
    const name = nameRaw.trim();
    if (!name) {
      this.context.emitError("validation_failed", "session", "MCP server name is required");
      return null;
    }

    const registry = await loadMCPConfigRegistry(this.context.state.config);
    const server = registry.servers.find((entry) => entry.name === name) ?? null;
    if (!server) {
      this.context.emitError("validation_failed", "session", `MCP server \"${name}\" not found.`);
      return null;
    }
    return server;
  }
}
