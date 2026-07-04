import type { EditableMCPServerConfigSource, MCPServerSource } from "../../mcp/configRegistry";
import type { MCPServerConfig, PluginScope } from "../../types";
import { McpAuthFlow } from "./mcp/McpAuthFlow";
import { McpRegistryFlow } from "./mcp/McpRegistryFlow";
import { McpServerResolver } from "./mcp/McpServerResolver";
import { McpValidationFlow } from "./mcp/McpValidationFlow";
import type { SessionContext } from "./SessionContext";

export class McpManager {
  private readonly resolver: McpServerResolver;
  private readonly registryFlow: McpRegistryFlow;
  private readonly validationFlow: McpValidationFlow;
  private readonly authFlow: McpAuthFlow;

  constructor(context: SessionContext) {
    this.resolver = new McpServerResolver(context);
    this.registryFlow = new McpRegistryFlow(context);
    this.validationFlow = new McpValidationFlow(context, this.resolver);
    this.authFlow = new McpAuthFlow(context, this.resolver, async () => {
      await this.registryFlow.emitMcpServers();
    });
  }

  close() {
    this.authFlow.close();
  }

  async setEnableMcp(enableMcp: boolean) {
    await this.registryFlow.setEnableMcp(enableMcp);
  }

  prepareEnableMcpChange(enableMcp: boolean) {
    return this.registryFlow.prepareEnableMcpChange(enableMcp);
  }

  async applyPreparedEnableMcpChange(
    prepared: ReturnType<McpRegistryFlow["prepareEnableMcpChange"]>,
    opts?: { persistDefaults?: boolean; queuePersistSessionSnapshot?: boolean },
  ) {
    return await this.registryFlow.applyPreparedEnableMcpChange(prepared, opts);
  }

  async emitMcpServers() {
    await this.registryFlow.emitMcpServers();
  }

  async upsert(
    server: MCPServerConfig,
    previousName?: string,
    source: EditableMCPServerConfigSource = "workspace",
  ) {
    const validateName = await this.registryFlow.upsert(server, previousName, source);
    if (validateName) void this.validate(validateName, source);
  }

  async delete(nameRaw: string, source?: EditableMCPServerConfigSource) {
    await this.registryFlow.delete(nameRaw, source);
  }

  async setEnabled(opts: {
    name: string;
    source: "workspace" | "user" | "plugin" | "system";
    enabled: boolean;
    pluginId?: string;
    pluginScope?: PluginScope;
  }) {
    await this.registryFlow.setEnabled(opts);
  }

  async validate(nameRaw: string, source?: MCPServerSource) {
    await this.validationFlow.validate(nameRaw, source);
  }

  async authorize(nameRaw: string, source?: MCPServerSource) {
    await this.authFlow.authorize(nameRaw, source);
  }

  async callback(nameRaw: string, codeRaw?: string, source?: MCPServerSource) {
    const validateServer = await this.authFlow.callback(nameRaw, codeRaw, source);
    if (validateServer) void this.validate(validateServer.name, validateServer.source);
  }

  async setApiKey(nameRaw: string, apiKeyRaw: string, source?: MCPServerSource) {
    const validateServer = await this.authFlow.setApiKey(nameRaw, apiKeyRaw, source);
    if (validateServer) void this.validate(validateServer.name, validateServer.source);
  }
}
