import fs from "node:fs/promises";
import path from "node:path";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import type { AgentConfig, MCPServerConfig } from "../types";
import {
  completeMCPServerOAuth,
  resolveMCPServerAuthState,
  setMCPServerOAuthClientInformation,
  type MCPAuthMode,
  type MCPAuthScope,
  type MCPServerOAuthClientInfo,
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

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const oauthProviderTokensSchema = z.object({
  access_token: nonEmptyTrimmedStringSchema,
  token_type: nonEmptyTrimmedStringSchema.optional(),
  refresh_token: nonEmptyTrimmedStringSchema.optional(),
  expires_in: z.preprocess((value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }, z.number().finite().optional()),
  scope: nonEmptyTrimmedStringSchema.optional(),
}).passthrough();
const oauthClientInformationSchema = z.object({
  client_id: nonEmptyTrimmedStringSchema,
  client_secret: nonEmptyTrimmedStringSchema.optional(),
}).passthrough();
const retryCountSchema = z.number().finite().transform((value) => Math.max(0, Math.floor(value)));
const mcpToolRecordSchema = z.record(z.string(), z.unknown());
type RuntimeMcpClient = {
  tools: () => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
};
const runtimeMcpClientSchema = z.custom<RuntimeMcpClient>((value) => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const maybeClient = value as { tools?: unknown; close?: unknown };
  return typeof maybeClient.tools === "function" && typeof maybeClient.close === "function";
});

type RuntimeMcpHttpTransport = Extract<MCPServerConfig["transport"], { type: "http" | "sse" }> & {
  authProvider?: OAuthClientProvider;
};
type RuntimeMcpTransport = Extract<MCPServerConfig["transport"], { type: "stdio" }> | RuntimeMcpHttpTransport;
type RuntimeMcpClientFactory = (opts: { name: string; transport: RuntimeMcpTransport }) => Promise<RuntimeMcpClient>;

function normalizeToolArguments(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

async function createRuntimeMcpClient(opts: {
  name: string;
  transport: RuntimeMcpTransport;
}): Promise<RuntimeMcpClient> {
  const client = new McpClient({ name: `agent-coworker/${opts.name}`, version: "0.1.0" });

  const requestInit = (() => {
    if (opts.transport.type === "stdio") return undefined;
    if (!opts.transport.headers || Object.keys(opts.transport.headers).length === 0) return undefined;
    return { headers: opts.transport.headers };
  })();

  const transport =
    opts.transport.type === "stdio"
      ? new StdioClientTransport({
          command: opts.transport.command,
          args: opts.transport.args ?? [],
          env: opts.transport.env,
          cwd: opts.transport.cwd,
        })
      : opts.transport.type === "sse"
        ? new SSEClientTransport(new URL(opts.transport.url), {
            ...(requestInit ? { requestInit } : {}),
            ...(opts.transport.authProvider ? { authProvider: opts.transport.authProvider } : {}),
          })
        : new StreamableHTTPClientTransport(new URL(opts.transport.url), {
            ...(requestInit ? { requestInit } : {}),
            ...(opts.transport.authProvider ? { authProvider: opts.transport.authProvider } : {}),
          });

  await client.connect(transport);

  return {
    tools: async () => {
      const listed = await client.listTools();
      const discovered: Record<string, unknown> = {};
      for (const entry of listed.tools ?? []) {
        discovered[entry.name] = {
          description: entry.description ?? `MCP tool ${entry.name}`,
          inputSchema: entry.inputSchema ?? { type: "object", properties: {}, additionalProperties: true },
          execute: async (input: unknown) =>
            await client.callTool({
              name: entry.name,
              arguments: normalizeToolArguments(input),
            }),
        };
      }
      return discovered;
    },
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
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

function toStoredOAuthTokens(tokens: z.infer<typeof oauthProviderTokensSchema>): Omit<MCPServerOAuthTokens, "updatedAt"> {
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
  clientInfo?: MCPServerOAuthClientInfo;
}): OAuthClientProvider | undefined {
  if (opts.mode !== "oauth" || !opts.tokens) return undefined;

  let latestTokens: MCPServerOAuthTokens | undefined = opts.tokens;
  let latestClientInfo: MCPServerOAuthClientInfo | undefined = opts.clientInfo;
  const redirectUrl = opts.redirectUri ?? "http://127.0.0.1/oauth/callback";

  return {
    tokens: async () => {
      if (!latestTokens) return undefined;
      return toOAuthTokensForSdk(latestTokens);
    },
    saveTokens: async (tokens) => {
      const parsedTokens = oauthProviderTokensSchema.safeParse(tokens);
      if (!parsedTokens.success) return;

      const storedTokens = toStoredOAuthTokens(parsedTokens.data);
      latestTokens = {
        ...storedTokens,
        updatedAt: new Date().toISOString(),
      };
      try {
        await completeMCPServerOAuth({
          config: opts.config,
          server: opts.server,
          tokens: storedTokens,
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
        client_name: "Agent Coworker",
      };
    },
    clientInformation: async () => {
      if (!latestClientInfo) return undefined;
      return {
        client_id: latestClientInfo.clientId,
        ...(latestClientInfo.clientSecret
          ? { client_secret: latestClientInfo.clientSecret }
          : {}),
      };
    },
    saveClientInformation: async (info) => {
      const parsedInfo = oauthClientInformationSchema.safeParse(info);
      if (!parsedInfo.success) return;

      const clientId = parsedInfo.data.client_id;
      const clientSecret = parsedInfo.data.client_secret;
      latestClientInfo = {
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        updatedAt: new Date().toISOString(),
      };
      try {
        await setMCPServerOAuthClientInformation({
          config: opts.config,
          server: opts.server,
          clientInformation: { clientId, ...(clientSecret ? { clientSecret } : {}) },
        });
      } catch {
        // best effort persistence only
      }
    },
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
        clientInfo: auth.oauthClientInfo,
      });
      if (provider) {
        runtimeServer.transport = {
          ...runtimeServer.transport,
          authProvider: provider,
        } as MCPServerConfig["transport"];
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
}> {
  const workspaceDoc = await readWorkspaceMCPServersDocument(config);
  const effectiveServers = await loadMCPServers(config);
  return {
    path: workspaceDoc.path,
    rawJson: workspaceDoc.rawJson,
    projectServers: workspaceDoc.workspaceServers,
    effectiveServers,
  };
}

export async function writeProjectMCPServersDocument(projectAgentDir: string, rawJson: string): Promise<void> {
  parseMCPServersDocument(rawJson);
  const workspaceRoot = path.dirname(projectAgentDir);
  const workspaceCoworkDir = path.join(workspaceRoot, ".cowork");
  await fs.mkdir(workspaceCoworkDir, { recursive: true });
  const filePath = path.join(workspaceCoworkDir, MCP_SERVERS_FILE_NAME);
  const payload = rawJson.endsWith("\n") ? rawJson : `${rawJson}\n`;
  const tempPath = path.join(
    workspaceCoworkDir,
    `.mcp-servers.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tempPath, payload, "utf-8");
  await fs.rename(tempPath, filePath);
}

export async function loadMCPTools(
  servers: MCPServerConfig[],
  opts: {
    log?: (line: string) => void;
    createClient?: RuntimeMcpClientFactory;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ tools: Record<string, unknown>; errors: string[]; close: () => Promise<void> }> {
  const createClient = opts.createClient ?? createRuntimeMcpClient;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const tools: Record<string, unknown> = {};
  const errors: string[] = [];
  const clients: Array<{ name: string; close: () => Promise<void> }> = [];
  let closed = false;

  const retriesFor = (value: unknown): number => {
    const parsed = retryCountSchema.safeParse(value);
    return parsed.success ? parsed.data : 3;
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
      let client: RuntimeMcpClient | null = null;
      try {
        const rawClient = await createClient({
          name: server.name,
          transport: server.transport as RuntimeMcpTransport,
        });
        const parsedClient = runtimeMcpClientSchema.safeParse(rawClient);
        if (!parsedClient.success) {
          throw new Error(`MCP client for ${server.name} has an invalid runtime shape.`);
        }
        client = parsedClient.data;

        const discoveredRaw = await client.tools();
        const discoveredParsed = mcpToolRecordSchema.safeParse(discoveredRaw);
        if (!discoveredParsed.success) {
          throw new Error(`MCP client for ${server.name} returned invalid tool definitions.`);
        }
        const discovered = discoveredParsed.data;

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

