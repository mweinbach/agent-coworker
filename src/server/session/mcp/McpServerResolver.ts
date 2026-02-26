import type { MCPRegistryServer } from "../../../mcp/configRegistry";
import type { SessionContext } from "../SessionContext";

export class McpServerResolver {
  constructor(private readonly context: SessionContext) {}

  async resolveByName(nameRaw: string): Promise<MCPRegistryServer | null> {
    return await this.context.getMcpServerByName(nameRaw);
  }
}
