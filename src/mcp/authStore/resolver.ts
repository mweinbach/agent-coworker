import { maskApiKey } from "../../connect";
import type { AgentConfig, MCPServerAuthConfig } from "../../types";
import type { MCPRegistryServer } from "../configRegistry/types";
import { readMCPAuthFiles, selectCredentialRecord } from "./store";
import type {
  MCPResolvedServerAuth,
  MCPServerOAuthClientInfo,
  MCPServerOAuthPending,
  MCPServerOAuthTokens,
} from "./types";

function isPendingValid(pending: MCPServerOAuthPending): boolean {
  const expiresAt = Date.parse(pending.expiresAt);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function isTokenValid(tokens: MCPServerOAuthTokens): boolean {
  if (!tokens.expiresAt) return true;
  const expiresAt = Date.parse(tokens.expiresAt);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function joinAuthHeader(prefix: string | undefined, value: string): string {
  const trimmedPrefix = prefix?.trim();
  if (!trimmedPrefix) return value;
  return `${trimmedPrefix} ${value}`;
}

function resolveApiKeyHeader(auth: Extract<MCPServerAuthConfig, { type: "api_key" }>, apiKey: string): Record<string, string> {
  const headerName = auth.headerName?.trim() || "Authorization";
  const prefix = auth.prefix?.trim() ?? (headerName.toLowerCase() === "authorization" ? "Bearer" : "");
  return {
    [headerName]: joinAuthHeader(prefix, apiKey),
  };
}

export async function resolveMCPServerAuthState(
  config: AgentConfig,
  server: MCPRegistryServer,
): Promise<MCPResolvedServerAuth> {
  const auth = server.auth ?? { type: "none" as const };
  const files = await readMCPAuthFiles(config);
  const selected = selectCredentialRecord({
    byScope: files,
    source: server.source,
    serverName: server.name,
  });

  if (auth.type === "none") {
    return {
      mode: "none",
      scope: selected.scope,
      authType: "none",
      message: "No authentication required.",
    };
  }

  if (auth.type === "api_key") {
    const apiKeyValue = selected.record?.apiKey?.value;
    if (!apiKeyValue) {
      return {
        mode: "missing",
        scope: selected.scope,
        authType: "api_key",
        message: "API key required.",
      };
    }
    return {
      mode: "api_key",
      scope: selected.scope,
      authType: "api_key",
      message: `API key available (${maskApiKey(apiKeyValue)}).`,
      headers: resolveApiKeyHeader(auth, apiKeyValue),
      apiKey: apiKeyValue,
    };
  }

  const pending = selected.record?.oauth?.pending;
  const tokens = selected.record?.oauth?.tokens;
  const clientInfo = selected.record?.oauth?.clientInformation;
  const hasAccessToken = Boolean(tokens?.accessToken);
  const hasRefreshToken = Boolean(tokens?.refreshToken && tokens.refreshToken.trim().length > 0);
  const tokenValid = tokens ? isTokenValid(tokens) : false;

  if (hasAccessToken && tokenValid && tokens) {
    return {
      mode: "oauth",
      scope: selected.scope,
      authType: "oauth",
      message: "OAuth token available.",
      headers: {
        Authorization: joinAuthHeader(tokens.tokenType ?? "Bearer", tokens.accessToken),
      },
      oauthTokens: tokens,
      ...(pending ? { oauthPending: pending } : {}),
      ...(clientInfo ? { oauthClientInfo: clientInfo } : {}),
    };
  }

  if (hasAccessToken && !tokenValid && hasRefreshToken && tokens) {
    return {
      mode: "oauth",
      scope: selected.scope,
      authType: "oauth",
      message: "OAuth access token expired; refresh token available.",
      headers: {
        Authorization: joinAuthHeader(tokens.tokenType ?? "Bearer", tokens.accessToken),
      },
      oauthTokens: tokens,
      ...(pending ? { oauthPending: pending } : {}),
      ...(clientInfo ? { oauthClientInfo: clientInfo } : {}),
    };
  }

  if (pending && isPendingValid(pending)) {
    return {
      mode: "oauth_pending",
      scope: selected.scope,
      authType: "oauth",
      message: "OAuth flow is waiting for callback.",
      oauthPending: pending,
      ...(clientInfo ? { oauthClientInfo: clientInfo } : {}),
    };
  }

  if (hasAccessToken && !tokenValid && tokens) {
    return {
      mode: "error",
      scope: selected.scope,
      authType: "oauth",
      message: "OAuth token expired. Re-authorize this server.",
      oauthTokens: tokens,
      ...(pending ? { oauthPending: pending } : {}),
      ...(clientInfo ? { oauthClientInfo: clientInfo } : {}),
    };
  }

  if (pending && !isPendingValid(pending)) {
    return {
      mode: "error",
      scope: selected.scope,
      authType: "oauth",
      message: "OAuth authorization expired. Re-authorize this server.",
      oauthPending: pending,
      ...(clientInfo ? { oauthClientInfo: clientInfo } : {}),
    };
  }

  return {
    mode: "missing",
    scope: selected.scope,
    authType: "oauth",
    message: "OAuth authorization required.",
  };
}

export async function readMCPServerOAuthPending(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
}): Promise<{ pending?: MCPServerOAuthPending; scope: "workspace" | "user" }> {
  const files = await readMCPAuthFiles(opts.config);
  const selected = selectCredentialRecord({
    byScope: files,
    source: opts.server.source,
    serverName: opts.server.name,
  });
  return {
    scope: selected.scope,
    pending: selected.record?.oauth?.pending,
  };
}

export async function readMCPServerOAuthClientInformation(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
}): Promise<{ clientInformation?: MCPServerOAuthClientInfo; scope: "workspace" | "user" }> {
  const files = await readMCPAuthFiles(opts.config);
  const selected = selectCredentialRecord({
    byScope: files,
    source: opts.server.source,
    serverName: opts.server.name,
  });
  return {
    scope: selected.scope,
    clientInformation: selected.record?.oauth?.clientInformation,
  };
}
