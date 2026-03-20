import { readMCPServersSnapshot } from "../../../mcp";
import {
  deleteWorkspaceMCPServer,
  migrateLegacyMCPServers,
  upsertWorkspaceMCPServer,
} from "../../../mcp/configRegistry";
import type { MCPServerConfig } from "../../../types";
import type { SessionContext } from "../SessionContext";

type PreparedEnableMcpChange = {
  enableMcp: boolean;
  changed: boolean;
};

export class McpRegistryFlow {
  constructor(private readonly context: SessionContext) {}

  prepareEnableMcpChange(enableMcp: boolean): PreparedEnableMcpChange {
    return {
      enableMcp,
      changed: (this.context.state.config.enableMcp ?? false) !== enableMcp,
    };
  }

  async applyPreparedEnableMcpChange(
    prepared: PreparedEnableMcpChange,
    opts?: { persistDefaults?: boolean; queuePersistSessionSnapshot?: boolean },
  ): Promise<unknown | null> {
    this.context.state.config = { ...this.context.state.config, enableMcp: prepared.enableMcp };

    let persistError: unknown = null;
    if (opts?.persistDefaults !== false && this.context.deps.persistProjectConfigPatchImpl) {
      try {
        await this.context.deps.persistProjectConfigPatchImpl({ enableMcp: prepared.enableMcp });
      } catch (err) {
        persistError = err;
      }
    }

    this.context.emit({
      type: "session_settings",
      sessionId: this.context.id,
      enableMcp: prepared.enableMcp,
      enableMemory: this.context.state.config.enableMemory ?? true,
      memoryRequireApproval: this.context.state.config.memoryRequireApproval ?? false,
    });
    if (opts?.queuePersistSessionSnapshot !== false) {
      this.context.queuePersistSessionSnapshot("session.enable_mcp");
    }

    return persistError;
  }

  async setEnableMcp(enableMcp: boolean) {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }

    const prepared = this.prepareEnableMcpChange(enableMcp);
    if (!prepared.changed) {
      this.context.emitTelemetry("session.defaults.noop", "ok", {
        sessionId: this.context.id,
        operation: "set_enable_mcp",
      });
      return;
    }

    const persistError = await this.applyPreparedEnableMcpChange(prepared);

    if (persistError) {
      this.context.emitError(
        "internal_error",
        "session",
        `MCP setting updated for this session, but failed to persist defaults: ${String(persistError)}`,
      );
    }
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
