import { loadMCPServers, loadMCPTools, readMCPServersSnapshot } from "../../mcp";
import {
  completeMCPServerOAuth,
  readMCPServerOAuthClientInformation,
  readMCPServerOAuthPending,
  resolveMCPServerAuthState,
  setMCPServerApiKeyCredential,
  setMCPServerOAuthClientInformation,
  setMCPServerOAuthPending,
} from "../../mcp/authStore";
import {
  deleteWorkspaceMCPServer,
  loadMCPConfigRegistry,
  migrateLegacyMCPServers,
  upsertWorkspaceMCPServer,
  type MCPRegistryServer,
} from "../../mcp/configRegistry";
import { authorizeMCPServerOAuth, consumeCapturedOAuthCode, exchangeMCPServerOAuthCode } from "../../mcp/oauthProvider";
import type { MCPServerConfig } from "../../types";
import type { SessionContext } from "./SessionContext";

const MCP_VALIDATION_TIMEOUT_MS = 3_000;

export class McpManager {
  constructor(private readonly context: SessionContext) {}

  async setEnableMcp(enableMcp: boolean) {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }

    this.context.state.config = { ...this.context.state.config, enableMcp };
    this.context.emit({ type: "session_settings", sessionId: this.context.id, enableMcp });
    let persistDefaultsError: string | null = null;
    if (this.context.deps.persistProjectConfigPatchImpl) {
      try {
        await this.context.deps.persistProjectConfigPatchImpl({ enableMcp });
      } catch (err) {
        persistDefaultsError = String(err);
      }
    }
    if (persistDefaultsError) {
      this.context.emitError(
        "internal_error",
        "session",
        `MCP setting updated for this session, but persisting defaults failed: ${persistDefaultsError}`
      );
    }
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

  async upsert(server: MCPServerConfig, previousName?: string) {
    if (!this.context.guardBusy()) return;

    try {
      await upsertWorkspaceMCPServer(this.context.state.config, server, previousName);
    } catch (err) {
      const message = String(err);
      if (message.toLowerCase().includes("mcp-servers.json")) {
        this.context.emitError("validation_failed", "session", message);
        return;
      }
      this.context.emitError("internal_error", "session", `Failed to upsert MCP server: ${message}`);
      return;
    }

    await this.emitMcpServers();
    void this.validate(server.name);
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

  async validate(nameRaw: string) {
    const name = nameRaw.trim();
    if (!name) {
      this.context.emitError("validation_failed", "session", "MCP server name is required");
      return;
    }
    if (!this.context.guardBusy()) return;

    this.context.state.connecting = true;
    try {
      const server = await this.resolveMcpServerByName(name);
      if (!server) {
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name,
          ok: false,
          mode: "error",
          message: `MCP server \"${name}\" not found.`,
        });
        return;
      }

      const authState = await resolveMCPServerAuthState(this.context.state.config, server);
      if (authState.mode === "missing" || authState.mode === "oauth_pending" || authState.mode === "error") {
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name: server.name,
          ok: false,
          mode: authState.mode,
          message: authState.message,
        });
        return;
      }

      const runtimeServers = await loadMCPServers(this.context.state.config);
      const runtimeServer = runtimeServers.find((entry) => entry.name === server.name);
      if (!runtimeServer) {
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name: server.name,
          ok: false,
          mode: "error",
          message: "Server is not active in current MCP layering.",
        });
        return;
      }

      const startedAt = Date.now();
      const loadPromise = loadMCPTools([runtimeServer], { log: (line) => this.log(line) });
      let loadTimeout: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      try {
        const loaded = await Promise.race([
          loadPromise,
          new Promise<never>((_, reject) => {
            loadTimeout = setTimeout(() => {
              timedOut = true;
              reject(new Error(`MCP server validation timed out after ${MCP_VALIDATION_TIMEOUT_MS}ms.`));
            }, MCP_VALIDATION_TIMEOUT_MS);
          }),
        ]);

        const toolCount = Object.keys(loaded.tools).length;
        const latencyMs = Date.now() - startedAt;
        const ok = loaded.errors.length === 0;
        const message = ok ? "MCP server validation succeeded." : loaded.errors[0] ?? "MCP server validation failed.";
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name: server.name,
          ok,
          mode: authState.mode,
          message,
          toolCount,
          latencyMs,
        });
        await loaded.close();
      } catch (err) {
        if (timedOut) {
          void loadPromise
            .then(async (loaded) => {
              try {
                await loaded.close();
              } catch {
                // ignore
              }
            })
            .catch(() => {
              // ignore
            });
        }
        this.context.emit({
          type: "mcp_server_validation",
          sessionId: this.context.id,
          name: server.name,
          ok: false,
          mode: authState.mode,
          message: String(err),
          latencyMs: Date.now() - startedAt,
        });
      } finally {
        if (loadTimeout) clearTimeout(loadTimeout);
      }
    } catch (err) {
      this.context.emit({
        type: "mcp_server_validation",
        sessionId: this.context.id,
        name,
        ok: false,
        mode: "error",
        message: String(err),
      });
    } finally {
      this.context.state.connecting = false;
    }
  }

  async authorize(nameRaw: string) {
    if (!this.context.guardBusy()) return;

    const server = await this.resolveMcpServerByName(nameRaw);
    if (!server) return;

    if (!server.auth || server.auth.type !== "oauth") {
      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: false,
        mode: "missing",
        message: `MCP server \"${server.name}\" does not support OAuth authorization.`,
      });
      return;
    }

    this.context.state.connecting = true;
    try {
      const storedClientState = await readMCPServerOAuthClientInformation({
        config: this.context.state.config,
        server,
      });

      const result = await authorizeMCPServerOAuth(server, storedClientState.clientInformation);
      if (result.clientInformation) {
        await setMCPServerOAuthClientInformation({
          config: this.context.state.config,
          server,
          clientInformation: result.clientInformation,
        });
      }

      await setMCPServerOAuthPending({
        config: this.context.state.config,
        server,
        pending: result.pending,
      });
      this.context.emit({
        type: "mcp_server_auth_challenge",
        sessionId: this.context.id,
        name: server.name,
        challenge: result.challenge,
      });
      await this.emitMcpServers();
    } catch (err) {
      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: false,
        mode: "error",
        message: `MCP OAuth authorization failed: ${String(err)}`,
      });
    } finally {
      this.context.state.connecting = false;
    }
  }

  async callback(nameRaw: string, codeRaw?: string) {
    if (!this.context.guardBusy()) return;

    const server = await this.resolveMcpServerByName(nameRaw);
    if (!server) return;

    if (!server.auth || server.auth.type !== "oauth") {
      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: false,
        mode: "missing",
        message: `MCP server \"${server.name}\" does not support OAuth authorization.`,
      });
      return;
    }

    this.context.state.connecting = true;
    let validateName: string | null = null;
    try {
      const pendingState = await readMCPServerOAuthPending({ config: this.context.state.config, server });
      const pending = pendingState.pending;
      if (!pending) {
        this.context.emit({
          type: "mcp_server_auth_result",
          sessionId: this.context.id,
          name: server.name,
          ok: false,
          mode: "missing",
          message: "No pending OAuth challenge found. Start authorization first.",
        });
        return;
      }

      let code = codeRaw?.trim() || undefined;
      if (!code) {
        code = await consumeCapturedOAuthCode(pending.challengeId);
      }
      if (!code) {
        this.context.emit({
          type: "mcp_server_auth_result",
          sessionId: this.context.id,
          name: server.name,
          ok: true,
          mode: "oauth_pending",
          message: "OAuth callback is still pending. Paste a code to continue manually.",
        });
        return;
      }

      const storedClientState = await readMCPServerOAuthClientInformation({
        config: this.context.state.config,
        server,
      });
      const exchange = await exchangeMCPServerOAuthCode({
        server,
        code,
        pending,
        storedClientInfo: storedClientState.clientInformation,
      });
      await completeMCPServerOAuth({
        config: this.context.state.config,
        server,
        tokens: exchange.tokens,
        clearPending: true,
      });

      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: true,
        mode: "oauth",
        message: exchange.message,
      });
      await this.emitMcpServers();
      validateName = server.name;
    } catch (err) {
      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: false,
        mode: "error",
        message: `MCP OAuth callback failed: ${String(err)}`,
      });
    } finally {
      this.context.state.connecting = false;
      if (validateName) {
        void this.validate(validateName);
      }
    }
  }

  async setApiKey(nameRaw: string, apiKeyRaw: string) {
    if (!this.context.guardBusy()) return;

    const server = await this.resolveMcpServerByName(nameRaw);
    if (!server) return;

    if (!server.auth || server.auth.type !== "api_key") {
      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: false,
        mode: "missing",
        message: `MCP server \"${server.name}\" is not configured for API key auth.`,
      });
      return;
    }

    this.context.state.connecting = true;
    let validateName: string | null = null;
    try {
      const result = await setMCPServerApiKeyCredential({
        config: this.context.state.config,
        server,
        apiKey: apiKeyRaw,
        keyId: server.auth.keyId,
      });
      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: true,
        mode: "api_key",
        message: `API key saved (${result.maskedApiKey}) to ${result.scope} auth store.`,
      });
      await this.emitMcpServers();
      validateName = server.name;
    } catch (err) {
      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: false,
        mode: "error",
        message: `Setting MCP API key failed: ${String(err)}`,
      });
    } finally {
      this.context.state.connecting = false;
      if (validateName) {
        void this.validate(validateName);
      }
    }
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

  private async resolveMcpServerByName(nameRaw: string): Promise<MCPRegistryServer | null> {
    if (this.context.getMcpServerByName) {
      return await this.context.getMcpServerByName(nameRaw);
    }
    return await this.getMcpServerByName(nameRaw);
  }

  private async getMcpServerByName(nameRaw: string): Promise<MCPRegistryServer | null> {
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

  private log(line: string) {
    this.context.emit({ type: "log", sessionId: this.context.id, line });
  }
}
