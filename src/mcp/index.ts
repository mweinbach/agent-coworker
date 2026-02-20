import fs from "node:fs/promises";
import path from "node:path";

import { createMCPClient } from "@ai-sdk/mcp";
import type { OAuthClientProvider } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";

import type { AgentConfig, MCPServerConfig } from "../types";
import {
  completeMCPServerOAuth,
  resolveMCPServerAuthState,
  type MCPAuthMode,
  type MCPAuthScope,
  type MCPServerOAuthTokens,
} from "./authStore";
import {
  DEFAULT_MCP_SERVERS_DOCUMENT,
  MCP_SERVERS_FILE_NAME,
  loadMCPConfigRegistry,
  parseMCPServersDocument,
  readWorkspaceMCPServersDocument,
  resolveMcpConfigPaths,
  writeWorkspaceMCPServersDocument,
  type MCPConfigRegistrySnapshot,
  type MCPRegistryFileState,
  type MCPRegistryLegacyState,
  type MCPRegistryServer,
} from "./configRegistry";

export {
  DEFAULT_MCP_SERVERS_DOCUMENT,
  parseMCPServersDocument,
  loadMCPConfigRegistry,
  resolveMcpConfigPaths,
  readWorkspaceMCPServersDocument,
  writeWorkspaceMCPServersDocument,
};

export type MCPServerEffectiveState = MCPRegistryServer & {
  authMode: MCPAuthMode;
  authScope: MCPAuthScope;
  authMessage: string;
};

export interface MCPServersSnapshot {
  servers: MCPServerEffectiveState[];
  files: MCPRegistryFileState[];
  legacy: MCPRegistryLegacyState;
  warnings: string[];
}

function toOAuthTokensForSdk(tokens: MCPServerOAuthTokens): {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
} {
  const expiresIn = (() => {
    if (!tokens.expiresAt) return undefined;
    const expiresAt = Date.parse(tokens.expiresAt);
    if (!Number.isFinite(expiresAt)) return undefined;
    const seconds = Math.floor((expiresAt - Date.now()) / 1000);
    return Math.max(0, seconds);
  })();

  return {
    access_token: tokens.accessToken,
    token_type: tokens.tokenType ?? "Bearer",
    ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    ...(typeof expiresIn === "number" ? { expires_in: expiresIn } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  };
}

function toStoredOAuthTokens(tokens: {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}): Omit<MCPServerOAuthTokens, "updatedAt"> {
  const expiresAt = (() => {
    if (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in)) return undefined;
    return new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  })();

  return {
    accessToken: tokens.access_token,
    ...(tokens.token_type ? { tokenType: tokens.token_type } : {}),
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function createRuntimeOAuthProvider(opts: {
  config: AgentConfig;
  server: MCPRegistryServer;
  mode: MCPAuthMode;
  tokens?: MCPServerOAuthTokens;
  codeVerifier?: string;
  redirectUri?: string;
}): OAuthClientProvider | undefined {
  if (opts.mode !== "oauth" || !opts.tokens) return undefined;

  let latestTokens: MCPServerOAuthTokens | undefined = opts.tokens;
  const redirectUrl = opts.redirectUri ?? "http://127.0.0.1/oauth/callback";

  return {
    tokens: async () => {
      if (!latestTokens) return undefined;
      return toOAuthTokensForSdk(latestTokens);
    },
    saveTokens: async (tokens) => {
      latestTokens = {
        ...toStoredOAuthTokens(tokens as any),
        updatedAt: new Date().toISOString(),
      };
      try {
        await completeMCPServerOAuth({
          config: opts.config,
          server: opts.server,
          tokens: toStoredOAuthTokens(tokens as any),
          clearPending: false,
        });
      } catch {
        // best effort persistence only
      }
    },
    redirectToAuthorization: async () => {
      // Runtime MCP discovery should not trigger interactive auth flows.
      throw new Error(`MCP server \"${opts.server.name}\" requires interactive OAuth re-authorization.`);
    },
    saveCodeVerifier: async () => {
      // verifier persistence is handled by explicit session auth flows.
    },
    codeVerifier: async () => opts.codeVerifier ?? "",
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return {
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: async () => undefined,
  };
}

async function hydrateServerForRuntime(config: AgentConfig, server: MCPRegistryServer): Promise<MCPServerConfig> {
  const auth = await resolveMCPServerAuthState(config, server);

  if (server.transport.type === "http" || server.transport.type === "sse") {
    const existingHeaders = server.transport.headers ?? {};
    const mergedHeaders = auth.headers ? { ...existingHeaders, ...auth.headers } : existingHeaders;

    const runtimeServer: MCPServerConfig = {
      name: server.name,
      required: server.required,
      retries: server.retries,
      auth: server.auth,
      transport: {
        ...server.transport,
        ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
      },
    };

    if (server.auth?.type === "oauth") {
      const provider = createRuntimeOAuthProvider({
        config,
        server,
        mode: auth.mode,
        tokens: auth.oauthTokens,
        codeVerifier: auth.oauthPending?.codeVerifier,
        redirectUri: auth.oauthPending?.redirectUri,
      });
      if (provider) {
        runtimeServer.transport = {
          ...(runtimeServer.transport as any),
          authProvider: provider,
        } as any;
      }
    }

    return runtimeServer;
  }

  return {
    name: server.name,
    transport: server.transport,
    required: server.required,
    retries: server.retries,
    auth: server.auth,
  };
}

export async function readMCPServersSnapshot(config: AgentConfig): Promise<MCPServersSnapshot> {
  const registry = await loadMCPConfigRegistry(config);
  const serversWithAuth = await Promise.all(
    registry.servers.map(async (server) => {
      const auth = await resolveMCPServerAuthState(config, server);
      return {
        ...server,
        authMode: auth.mode,
        authScope: auth.scope,
        authMessage: auth.message,
      };
    }),
  );

  return {
    servers: serversWithAuth,
    files: registry.files,
    legacy: registry.legacy,
    warnings: registry.warnings,
  };
}

export async function loadMCPServers(config: AgentConfig): Promise<MCPServerConfig[]> {
  const registry = await loadMCPConfigRegistry(config);
  const hydrated = await Promise.all(registry.servers.map(async (server) => await hydrateServerForRuntime(config, server)));
  return hydrated;
}

export async function readProjectMCPServersDocument(config: AgentConfig): Promise<{
  path: string;
  rawJson: string;
  projectServers: MCPServerConfig[];
  effectiveServers: MCPServerConfig[];
  parseError?: string;
}> {
  const workspaceDoc = await readWorkspaceMCPServersDocument(config);
  const effectiveServers = await loadMCPServers(config);
  return {
    path: workspaceDoc.path,
    rawJson: workspaceDoc.rawJson,
    projectServers: workspaceDoc.workspaceServers,
    effectiveServers,
    ...(workspaceDoc.parseError ? { parseError: workspaceDoc.parseError } : {}),
  };
}

export async function writeProjectMCPServersDocument(projectAgentDir: string, rawJson: string): Promise<void> {
  parseMCPServersDocument(rawJson);
  await fs.mkdir(projectAgentDir, { recursive: true });
  const filePath = path.join(projectAgentDir, MCP_SERVERS_FILE_NAME);
  const payload = rawJson.endsWith("\n") ? rawJson : `${rawJson}\n`;
  const tempPath = path.join(
    projectAgentDir,
    `.mcp-servers.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tempPath, payload, "utf-8");
  await fs.rename(tempPath, filePath);
}

export async function loadMCPTools(
  servers: MCPServerConfig[],
  opts: {
    log?: (line: string) => void;
    createClient?: typeof createMCPClient;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ tools: Record<string, any>; errors: string[]; close: () => Promise<void> }> {
  const createClient = opts.createClient ?? createMCPClient;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const tools: Record<string, any> = {};
  const errors: string[] = [];
  const clients: Array<{ name: string; close: () => Promise<void> }> = [];
  let closed = false;

  const retriesFor = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) return 3;
    return Math.max(0, Math.floor(value));
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const client of [...clients].reverse()) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  };

  for (const server of servers) {
    const retries = retriesFor(server.retries);

    for (let attempt = 0; attempt <= retries; attempt++) {
      let client: any | null = null;
      try {
        const transport =
          server.transport.type === "stdio"
            ? new Experimental_StdioMCPTransport({
                command: server.transport.command,
                args: server.transport.args || [],
                env: server.transport.env,
                cwd: server.transport.cwd,
              })
            : (server.transport as any);

        client = await createClient({
          name: server.name,
          transport,
        });

        const discovered = await client.tools();

        for (const [name, toolDef] of Object.entries(discovered)) {
          tools[`mcp__${server.name}__${name}`] = toolDef;
        }

        clients.push({ name: server.name, close: client.close.bind(client) });

        opts.log?.(`[MCP] Connected to ${server.name}: ${Object.keys(discovered).length} tools`);
        break;
      } catch (error) {
        try {
          await client?.close?.();
        } catch {
          // ignore
        }

        if (attempt === retries) {
          const message = `[MCP] Failed to connect to ${server.name} after ${attempt + 1} attempts: ${String(error)}`;
          if (server.required) {
            await close();
            throw new Error(message);
          }
          errors.push(message);
          opts.log?.(message);
        } else {
          opts.log?.(`[MCP] Retrying ${server.name} (attempt ${attempt + 2})...`);
          await sleep(1000 * (attempt + 1));
        }
      }
    }
  }

  return { tools, errors, close };
}

export function snapshotToRegistry(snapshot: MCPServersSnapshot): MCPConfigRegistrySnapshot {
  return {
    servers: snapshot.servers.map(({ authMode: _authMode, authMessage: _authMessage, authScope: _authScope, ...server }) => ({
      ...server,
    })),
    files: snapshot.files,
    legacy: snapshot.legacy,
    warnings: snapshot.warnings,
  };
}
