import {
  completeMCPServerOAuth,
  readMCPServerOAuthClientInformation,
  readMCPServerOAuthPending,
  setMCPServerApiKeyCredential,
  setMCPServerOAuthClientInformation,
  setMCPServerOAuthPending,
} from "../../../mcp/authStore";
import { authorizeMCPServerOAuth, consumeCapturedOAuthCode, exchangeMCPServerOAuthCode } from "../../../mcp/oauthProvider";
import type { SessionContext } from "../SessionContext";
import { McpServerResolver } from "./McpServerResolver";

export class McpAuthFlow {
  constructor(
    private readonly context: SessionContext,
    private readonly resolver: McpServerResolver,
    private readonly emitMcpServers: () => Promise<void>,
  ) {}

  async authorize(nameRaw: string) {
    if (!this.context.guardBusy()) return;

    const server = await this.resolver.resolveByName(nameRaw);
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

  async callback(nameRaw: string, codeRaw?: string): Promise<string | null> {
    if (!this.context.guardBusy()) return null;

    const server = await this.resolver.resolveByName(nameRaw);
    if (!server) return null;

    if (!server.auth || server.auth.type !== "oauth") {
      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: false,
        mode: "missing",
        message: `MCP server \"${server.name}\" does not support OAuth authorization.`,
      });
      return null;
    }

    this.context.state.connecting = true;
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
        return null;
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
        return null;
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
      return server.name;
    } catch (err) {
      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: false,
        mode: "error",
        message: `MCP OAuth callback failed: ${String(err)}`,
      });
      return null;
    } finally {
      this.context.state.connecting = false;
    }
  }

  async setApiKey(nameRaw: string, apiKeyRaw: string): Promise<string | null> {
    if (!this.context.guardBusy()) return null;

    const server = await this.resolver.resolveByName(nameRaw);
    if (!server) return null;

    if (!server.auth || server.auth.type !== "api_key") {
      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: false,
        mode: "missing",
        message: `MCP server \"${server.name}\" is not configured for API key auth.`,
      });
      return null;
    }

    this.context.state.connecting = true;
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
      return server.name;
    } catch (err) {
      this.context.emit({
        type: "mcp_server_auth_result",
        sessionId: this.context.id,
        name: server.name,
        ok: false,
        mode: "error",
        message: `Setting MCP API key failed: ${String(err)}`,
      });
      return null;
    } finally {
      this.context.state.connecting = false;
    }
  }
}
