import { readMCPServersSnapshot } from "../../../mcp";
import {
  deleteWorkspaceMCPServer,
  migrateLegacyMCPServers,
  upsertWorkspaceMCPServer,
} from "../../../mcp/configRegistry";
import type { MCPServerConfig } from "../../../types";
import type { SessionContext } from "../SessionContext";

export class McpRegistryFlow {
  constructor(private readonly context: SessionContext) {}

  async setEnableMcp(enableMcp: boolean) {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }

    if (this.context.deps.persistProjectConfigPatchImpl) {
      try {
        await this.context.deps.persistProjectConfigPatchImpl({ enableMcp });
      } catch (err) {
        this.context.emitError("internal_error", "session", `Failed to persist MCP defaults: ${String(err)}`);
        return;
      }
    }

    this.context.state.config = { ...this.context.state.config, enableMcp };
    this.context.emit({ type: "session_settings", sessionId: this.context.id, enableMcp });
    this.context.queuePersistSessionSnapshot("session.enable_mcp");
  }

  async emitMcpServers() {
    try {
      const payload = await readMCPServersSnapshot(this.context.state.config);
      this.context.emit({
        type: "mcp_servers",
        sessionId: this.context.id,
        servers: payload.servers,
        legacy: payload.legacy,
        files: payload.files,
        ...(payload.warnings.length > 0 ? { warnings: payload.warnings } : {}),
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to read MCP servers: ${String(err)}`);
    }
  }

  async upsert(server: MCPServerConfig, previousName?: string): Promise<string | null> {
    if (!this.context.guardBusy()) return null;

    try {
      await upsertWorkspaceMCPServer(this.context.state.config, server, previousName);
    } catch (err) {
      const message = String(err);
      if (message.toLowerCase().includes("mcp-servers.json")) {
        this.context.emitError("validation_failed", "session", message);
        return null;
      }
      this.context.emitError("internal_error", "session", `Failed to upsert MCP server: ${message}`);
      return null;
    }

    await this.emitMcpServers();
    return server.name;
  }

  async delete(nameRaw: string) {
    if (!this.context.guardBusy()) return;
    try {
      await deleteWorkspaceMCPServer(this.context.state.config, nameRaw);
    } catch (err) {
      const message = String(err);
      if (message.toLowerCase().includes("mcp-servers.json") || message.toLowerCase().includes("server name")) {
        this.context.emitError("validation_failed", "session", message);
        return;
      }
      this.context.emitError("internal_error", "session", `Failed to delete MCP server: ${message}`);
      return;
    }

    await this.emitMcpServers();
  }

  async migrate(scope: "workspace" | "user") {
    if (!this.context.guardBusy()) return;

    try {
      const result = await migrateLegacyMCPServers(this.context.state.config, scope);
      this.context.emit({
        type: "assistant_message",
        sessionId: this.context.id,
        text:
          `Legacy MCP migration (${scope}) complete: imported ${result.imported}, ` +
          `skipped ${result.skippedConflicts}.` +
          (result.archivedPath ? ` Archived legacy file to ${result.archivedPath}.` : ""),
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to migrate legacy MCP servers: ${String(err)}`);
      return;
    }

    await this.emitMcpServers();
  }
}
