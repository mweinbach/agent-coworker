import { maskApiKey } from "../../connect";
import type { AgentConfig } from "../../types";
import { nowIso } from "../../utils/typeGuards";
import type { MCPRegistryServer, MCPServerSource } from "../configRegistry/types";
import { mutateScopeDoc, readMCPAuthFiles, resolvePrimaryScope, resolveScopeReadOrder } from "./store";
import type {
  MCPAuthScope,
  MCPServerOAuthClientInfo,
  MCPServerOAuthPending,
  MCPServerOAuthTokens,
} from "./types";

function normalizeServerName(nameRaw: string): string {
  const name = nameRaw.trim();
  if (!name) throw new Error("Server name is required.");
  return name;
}

export async function setMCPServerApiKeyCredential(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
  apiKey: string;
  keyId?: string;
}): Promise<{ mode: "api_key"; storageFile: string; maskedApiKey: string; scope: MCPAuthScope }> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new Error("API key is required.");

  const scope = resolvePrimaryScope(opts.server.source);
  const filePath = await mutateScopeDoc(opts.config, scope, (doc) => {
    const name = normalizeServerName(opts.server.name);
    const existing = doc.servers[name] ?? {};
    const oauth = existing.oauth;
    doc.servers[name] = {
      ...existing,
      apiKey: {
        value: apiKey,
        ...(opts.keyId?.trim() ? { keyId: opts.keyId.trim() } : {}),
        updatedAt: nowIso(),
      },
      ...(oauth ? { oauth } : {}),
    };
  });

  return {
    mode: "api_key",
    storageFile: filePath,
    maskedApiKey: maskApiKey(apiKey),
    scope,
  };
}

export async function renameMCPServerCredentials(opts: {
  config: AgentConfig;
  source: MCPServerSource;
  previousName: string;
  nextName: string;
}): Promise<{ moved: boolean; scope: MCPAuthScope; storageFile?: string }> {
  const previousName = normalizeServerName(opts.previousName);
  const nextName = normalizeServerName(opts.nextName);
  const defaultScope = resolvePrimaryScope(opts.source);
  if (previousName === nextName) {
    return { moved: false, scope: defaultScope };
  }

  const files = await readMCPAuthFiles(opts.config);
  const scope = resolveScopeReadOrder(opts.source).find((candidate) => files[candidate].doc.servers[previousName] !== undefined);
  if (!scope) {
    return { moved: false, scope: defaultScope };
  }

  const storageFile = await mutateScopeDoc(opts.config, scope, (doc) => {
    const existing = doc.servers[previousName];
    if (!existing) return;
    doc.servers[nextName] = existing;
    delete doc.servers[previousName];
  });
  return { moved: true, scope, storageFile };
}

export async function setMCPServerOAuthPending(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
  pending: MCPServerOAuthPending;
}): Promise<{ storageFile: string; scope: MCPAuthScope }> {
  const scope = resolvePrimaryScope(opts.server.source);
  const filePath = await mutateScopeDoc(opts.config, scope, (doc) => {
    const name = normalizeServerName(opts.server.name);
    const existing = doc.servers[name] ?? {};
    doc.servers[name] = {
      ...existing,
      oauth: {
        ...(existing.oauth ?? {}),
        pending: opts.pending,
      },
    };
  });
  return { storageFile: filePath, scope };
}

export async function completeMCPServerOAuth(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
  tokens: Omit<MCPServerOAuthTokens, "updatedAt">;
  clearPending?: boolean;
}): Promise<{ storageFile: string; scope: MCPAuthScope }> {
  const scope = resolvePrimaryScope(opts.server.source);
  const filePath = await mutateScopeDoc(opts.config, scope, (doc) => {
    const name = normalizeServerName(opts.server.name);
    const existing = doc.servers[name] ?? {};
    const nextTokens: MCPServerOAuthTokens = {
      accessToken: opts.tokens.accessToken,
      ...(opts.tokens.tokenType ? { tokenType: opts.tokens.tokenType } : {}),
      ...(opts.tokens.refreshToken ? { refreshToken: opts.tokens.refreshToken } : {}),
      ...(opts.tokens.expiresAt ? { expiresAt: opts.tokens.expiresAt } : {}),
      ...(opts.tokens.scope ? { scope: opts.tokens.scope } : {}),
      ...(opts.tokens.resource ? { resource: opts.tokens.resource } : {}),
      updatedAt: nowIso(),
    };
    const pending = opts.clearPending === false ? existing.oauth?.pending : undefined;
    doc.servers[name] = {
      ...existing,
      oauth: {
        ...(pending ? { pending } : {}),
        tokens: nextTokens,
      },
    };
  });
  return { storageFile: filePath, scope };
}

export async function setMCPServerOAuthClientInformation(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
  clientInformation: Omit<MCPServerOAuthClientInfo, "updatedAt">;
}): Promise<{ storageFile: string; scope: MCPAuthScope }> {
  const scope = resolvePrimaryScope(opts.server.source);
  const filePath = await mutateScopeDoc(opts.config, scope, (doc) => {
    const name = normalizeServerName(opts.server.name);
    const existing = doc.servers[name] ?? {};
    doc.servers[name] = {
      ...existing,
      oauth: {
        ...(existing.oauth ?? {}),
        clientInformation: {
          clientId: opts.clientInformation.clientId,
          ...(opts.clientInformation.clientSecret
            ? { clientSecret: opts.clientInformation.clientSecret }
            : {}),
          updatedAt: nowIso(),
        },
      },
    };
  });
  return { storageFile: filePath, scope };
}
