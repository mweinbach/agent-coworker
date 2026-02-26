import type { MCPServerConfig } from "../../types";
import type { SessionContext } from "./SessionContext";
import { McpAuthFlow } from "./mcp/McpAuthFlow";
import { McpRegistryFlow } from "./mcp/McpRegistryFlow";
import { McpServerResolver } from "./mcp/McpServerResolver";
import { McpValidationFlow } from "./mcp/McpValidationFlow";

export class McpManager {
  private readonly resolver: McpServerResolver;
  private readonly registryFlow: McpRegistryFlow;
  private readonly validationFlow: McpValidationFlow;
  private readonly authFlow: McpAuthFlow;

  constructor(private readonly context: SessionContext) {
    this.resolver = new McpServerResolver(context);
    this.registryFlow = new McpRegistryFlow(context);
    this.validationFlow = new McpValidationFlow(context, this.resolver);
    this.authFlow = new McpAuthFlow(context, this.resolver, async () => {
      await this.registryFlow.emitMcpServers();
    });
  }

  async setEnableMcp(enableMcp: boolean) {
    await this.registryFlow.setEnableMcp(enableMcp);
  }

  async emitMcpServers() {
    await this.registryFlow.emitMcpServers();
  }

  async upsert(server: MCPServerConfig, previousName?: string) {
    const validateName = await this.registryFlow.upsert(server, previousName);
    if (validateName) void this.validate(validateName);
  }

  async delete(nameRaw: string) {
    await this.registryFlow.delete(nameRaw);
  }

  async validate(nameRaw: string) {
    await this.validationFlow.validate(nameRaw);
  }

  async authorize(nameRaw: string) {
    await this.authFlow.authorize(nameRaw);
  }

  async callback(nameRaw: string, codeRaw?: string) {
    const validateName = await this.authFlow.callback(nameRaw, codeRaw);
    if (validateName) void this.validate(validateName);
  }

  async setApiKey(nameRaw: string, apiKeyRaw: string) {
    const validateName = await this.authFlow.setApiKey(nameRaw, apiKeyRaw);
    if (validateName) void this.validate(validateName);
  }

  async migrate(scope: "workspace" | "user") {
    await this.registryFlow.migrate(scope);
  }
}
