import type { MCPServerOAuthPending } from "../../../mcp/authStore";
import {
  completeMCPServerOAuth,
  readMCPServerOAuthClientInformation,
  readMCPServerOAuthPending,
  setMCPServerApiKeyCredential,
  setMCPServerOAuthClientInformation,
  setMCPServerOAuthPending,
} from "../../../mcp/authStore";
import type { MCPRegistryServer } from "../../../mcp/configRegistry";
import {
  authorizeMCPServerOAuth,
  consumeCapturedOAuthCode,
  exchangeMCPServerOAuthCode,
} from "../../../mcp/oauthProvider";
import type { SessionContext } from "../SessionContext";
import type { McpServerResolver } from "./McpServerResolver";

const AUTO_OAUTH_POLL_INTERVAL_MS = 250;

type McpAuthFlowDeps = {
  authorizeMCPServerOAuth: typeof authorizeMCPServerOAuth;
  consumeCapturedOAuthCode: typeof consumeCapturedOAuthCode;
  exchangeMCPServerOAuthCode: typeof exchangeMCPServerOAuthCode;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class McpAuthFlow {
  private readonly autoCallbackControllers = new Map<string, AbortController>();

  constructor(
    private readonly context: SessionContext,
    private readonly resolver: McpServerResolver,
    private readonly emitMcpServers: () => Promise<void>,
    private readonly deps: McpAuthFlowDeps = {
      authorizeMCPServerOAuth,
      consumeCapturedOAuthCode,
      exchangeMCPServerOAuthCode,
    },
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
        message: `MCP server "${server.name}" does not support OAuth authorization.`,
      });
      return;
    }

    this.context.state.connecting = true;
    try {
      const storedClientState = await readMCPServerOAuthClientInformation({
        config: this.context.state.config,
        server,
      });

      const result = await this.deps.authorizeMCPServerOAuth(
        server,
        storedClientState.clientInformation,
      );
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
      this.startAutoOAuthCompletion(server, result.pending, result.challenge.method);
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
        message: `MCP server "${server.name}" does not support OAuth authorization.`,
      });
      return null;
    }

    this.context.state.connecting = true;
    try {
      const providedCode = codeRaw?.trim() || undefined;
      if (providedCode) {
        this.cancelAutoOAuthCompletion(server.name);
      }

      const pendingState = await readMCPServerOAuthPending({
        config: this.context.state.config,
        server,
      });
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

      let code = providedCode;
      if (!code) {
        code = await this.deps.consumeCapturedOAuthCode(pending.challengeId);
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

      return await this.completeOAuthCallback(server, pending, code);
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

  private cancelAutoOAuthCompletion(serverName: string) {
    const existing = this.autoCallbackControllers.get(serverName);
    if (!existing) return;
    existing.abort();
    this.autoCallbackControllers.delete(serverName);
  }

  private startAutoOAuthCompletion(
    server: MCPRegistryServer,
    pending: MCPServerOAuthPending,
    method: "auto" | "code",
  ) {
    if (method !== "auto") return;

    this.cancelAutoOAuthCompletion(server.name);
    const controller = new AbortController();
    this.autoCallbackControllers.set(server.name, controller);

    void this.completeAutoOAuthWhenReady(server, pending, controller.signal).finally(() => {
      if (this.autoCallbackControllers.get(server.name) === controller) {
        this.autoCallbackControllers.delete(server.name);
      }
    });
  }

  private async waitForConnectionIdle(deadlineMs: number, signal: AbortSignal): Promise<boolean> {
    while (!signal.aborted && Date.now() < deadlineMs) {
      if (!this.context.state.running && !this.context.state.connecting) {
        return true;
      }
      await sleep(AUTO_OAUTH_POLL_INTERVAL_MS, signal);
    }
    return false;
  }

  private async completeAutoOAuthWhenReady(
    server: MCPRegistryServer,
    pending: MCPServerOAuthPending,
    signal: AbortSignal,
  ) {
    const expiresAt = Date.parse(pending.expiresAt);
    const deadlineMs = Number.isFinite(expiresAt) ? expiresAt : Date.now() + 10 * 60_000;

    while (!signal.aborted && Date.now() < deadlineMs) {
      const pendingState = await readMCPServerOAuthPending({
        config: this.context.state.config,
        server,
      });
      const currentPending = pendingState.pending;
      if (!currentPending || currentPending.challengeId !== pending.challengeId) {
        return;
      }

      const code = await this.deps.consumeCapturedOAuthCode(pending.challengeId);
      if (!code) {
        await sleep(AUTO_OAUTH_POLL_INTERVAL_MS, signal);
        continue;
      }

      const ready = await this.waitForConnectionIdle(deadlineMs, signal);
      if (!ready) return;

      const latestPendingState = await readMCPServerOAuthPending({
        config: this.context.state.config,
        server,
      });
      const latestPending = latestPendingState.pending;
      if (!latestPending || latestPending.challengeId !== pending.challengeId) {
        return;
      }

      this.context.state.connecting = true;
      try {
        await this.completeOAuthCallback(server, latestPending, code);
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
      }
      return;
    }
  }

  private async completeOAuthCallback(
    server: MCPRegistryServer,
    pending: MCPServerOAuthPending,
    code: string,
  ): Promise<string> {
    const storedClientState = await readMCPServerOAuthClientInformation({
      config: this.context.state.config,
      server,
    });
    const exchange = await this.deps.exchangeMCPServerOAuthCode({
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
    this.cancelAutoOAuthCompletion(server.name);
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
        message: `MCP server "${server.name}" is not configured for API key auth.`,
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
