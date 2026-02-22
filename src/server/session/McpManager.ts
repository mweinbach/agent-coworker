import type { MCPServerConfig } from "../../types";

export class McpManager {
  constructor(
    private readonly handlers: {
      setEnableMcp: (enableMcp: boolean) => Promise<void>;
      emitMcpServers: () => Promise<void>;
      upsertMcpServer: (server: MCPServerConfig, previousName?: string) => Promise<void>;
      deleteMcpServer: (nameRaw: string) => Promise<void>;
      validateMcpServer: (nameRaw: string) => Promise<void>;
      authorizeMcpServerAuth: (nameRaw: string) => Promise<void>;
      callbackMcpServerAuth: (nameRaw: string, codeRaw?: string) => Promise<void>;
      setMcpServerApiKey: (nameRaw: string, apiKeyRaw: string) => Promise<void>;
      migrateLegacyMcpServers: (scope: "workspace" | "user") => Promise<void>;
    }
  ) {}

  setEnableMcp(enableMcp: boolean) {
    return this.handlers.setEnableMcp(enableMcp);
  }

  emitMcpServers() {
    return this.handlers.emitMcpServers();
  }

  upsert(server: MCPServerConfig, previousName?: string) {
    return this.handlers.upsertMcpServer(server, previousName);
  }

  delete(nameRaw: string) {
    return this.handlers.deleteMcpServer(nameRaw);
  }

  validate(nameRaw: string) {
    return this.handlers.validateMcpServer(nameRaw);
  }

  authorize(nameRaw: string) {
    return this.handlers.authorizeMcpServerAuth(nameRaw);
  }

  callback(nameRaw: string, codeRaw?: string) {
    return this.handlers.callbackMcpServerAuth(nameRaw, codeRaw);
  }

  setApiKey(nameRaw: string, apiKeyRaw: string) {
    return this.handlers.setMcpServerApiKey(nameRaw, apiKeyRaw);
  }

  migrate(scope: "workspace" | "user") {
    return this.handlers.migrateLegacyMcpServers(scope);
  }
}
