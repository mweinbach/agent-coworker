import fs from "node:fs/promises";
import path from "node:path";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildCodexAppsMcpServer } from "../server/connectors/openaiNativeConnectors";
import { CODEX_APPS_MCP_SERVER_NAME } from "../shared/openaiNativeConnectors";
import type { AgentConfig, MCPServerConfig } from "../types";
import { VERSION } from "../version";
import {
  completeMCPServerOAuth,
  type MCPAuthMode,
  type MCPAuthScope,
  type MCPServerOAuthClientInfo,
  type MCPServerOAuthTokens,
  mcpTokenEndpointAuthMethods,
  resolveMCPServerAuthState,
  setMCPServerOAuthClientInformation,
} from "./authStore";
import {
  DEFAULT_MCP_SERVERS_DOCUMENT,
  loadMCPConfigRegistry,
  MCP_SERVERS_FILE_NAME,
  type MCPRegistryFileState,
  type MCPRegistryServer,
  parseMCPServersDocument,
  readWorkspaceMCPServersDocument,
  writeWorkspaceMCPServersDocument,
} from "./configRegistry";
import { buildMcpToolName } from "./names";

export {
  DEFAULT_MCP_SERVERS_DOCUMENT,
  parseMCPServersDocument,
  readWorkspaceMCPServersDocument,
  writeWorkspaceMCPServersDocument,
};

type MCPServerEffectiveState = MCPRegistryServer & {
  authMode: MCPAuthMode;
  authScope: MCPAuthScope;
  authMessage: string;
};

export interface MCPServersSnapshot {
  servers: MCPServerEffectiveState[];
  files: MCPRegistryFileState[];
  warnings: string[];
}

// MCP tool descriptions are supplied by the (possibly remote, possibly
// workspace-controlled) server and handed straight to the model as tool context.
// A hostile server can stuff prompt-injection text here. We cannot neutralize
// natural-language injection, but we cap the length so a single tool cannot flood
// the context window or bury the rest of the toolset.
const MAX_MCP_DESCRIPTION_LENGTH = 4_000;

function capMcpDescription(description: string): string {
  if (description.length <= MAX_MCP_DESCRIPTION_LENGTH) return description;
  return `${description.slice(0, MAX_MCP_DESCRIPTION_LENGTH)}… [description truncated]`;
}

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const oauthProviderTokensSchema = z
  .object({
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
  })
  .passthrough();
const oauthClientInformationSchema = z
  .object({
    client_id: nonEmptyTrimmedStringSchema,
    client_secret: nonEmptyTrimmedStringSchema.optional(),
    token_endpoint_auth_method: z.enum(mcpTokenEndpointAuthMethods).optional(),
    redirect_uris: z.array(nonEmptyTrimmedStringSchema).min(1).optional(),
  })
  .passthrough();
const retryCountSchema = z
  .number()
  .finite()
  .transform((value) => Math.max(0, Math.floor(value)));
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
type RuntimeMcpTransport =
  | Extract<MCPServerConfig["transport"], { type: "stdio" }>
  | RuntimeMcpHttpTransport;
type RuntimeMcpClientFactory = (opts: {
  name: string;
  transport: RuntimeMcpTransport;
}) => Promise<RuntimeMcpClient>;
type RuntimeMcpServerConfig = MCPServerConfig & {
  enabledConnectorIds?: string[];
};

function normalizeToolArguments(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

function normalizeToolMeta(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

function normalizeMcpSchemaArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => normalizeMcpJsonSchema(entry)).filter((entry) => entry !== undefined);
}

function collapseMcpTupleSchemas(entries: unknown[]): unknown | undefined {
  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0];

  const first = JSON.stringify(entries[0]);
  if (entries.every((entry) => JSON.stringify(entry) === first)) {
    return entries[0];
  }

  return { anyOf: entries };
}

function normalizeMcpJsonSchema(value: unknown, root = false): unknown {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => normalizeMcpJsonSchema(entry));
  if (typeof value !== "object" || value === null) return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const tupleItems = Array.isArray(input.items) ? normalizeMcpSchemaArray(input.items) : [];
  const prefixItems = normalizeMcpSchemaArray(input.prefixItems);
  const normalizedItems = collapseMcpTupleSchemas(tupleItems.length > 0 ? tupleItems : prefixItems);
  for (const [key, entry] of Object.entries(input)) {
    if (key === "$schema" || key === "additionalItems" || key === "prefixItems") continue;
    if (
      key === "properties" &&
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry)
    ) {
      output.properties = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([propName, propSchema]) => [
          propName,
          normalizeMcpJsonSchema(propSchema),
        ]),
      );
      continue;
    }
    if (key === "items") {
      if (Array.isArray(entry)) {
        if (normalizedItems !== undefined) {
          output.items = normalizedItems;
        }
        continue;
      }
      output.items = normalizeMcpJsonSchema(entry);
      continue;
    }
    if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      output[key] = Array.isArray(entry)
        ? entry.map((schema) => normalizeMcpJsonSchema(schema))
        : entry;
      continue;
    }
    // Cap nested description strings too: a hostile server can stuff a huge
    // prompt-injection payload into a property/enum description, which is handed
    // to the model as tool context just like the top-level description.
    if (key === "description" && typeof entry === "string") {
      output[key] = capMcpDescription(entry);
      continue;
    }
    output[key] = normalizeMcpJsonSchema(entry);
  }

  if (output.items === undefined && prefixItems.length > 0 && normalizedItems !== undefined) {
    output.items = normalizedItems;
  }
  if (
    tupleItems.length > 0 &&
    input.additionalItems === false &&
    typeof output.maxItems !== "number" &&
    typeof input.maxItems !== "number"
  ) {
    output.maxItems = tupleItems.length;
  }
  if (
    prefixItems.length > 0 &&
    input.items === undefined &&
    typeof output.maxItems !== "number" &&
    typeof input.maxItems !== "number"
  ) {
    output.maxItems = prefixItems.length;
  }

  const hasTypeLike =
    "type" in output ||
    "$ref" in output ||
    "anyOf" in output ||
    "oneOf" in output ||
    "allOf" in output ||
    "const" in output ||
    "enum" in output;
  if (!hasTypeLike) {
    output.type =
      root || "properties" in output
        ? "object"
        : ["string", "number", "boolean", "object", "array", "null"];
  }
  return output;
}

async function createRuntimeMcpClient(opts: {
  name: string;
  transport: RuntimeMcpTransport;
}): Promise<RuntimeMcpClient> {
  const client = new McpClient({ name: `agent-coworker/${opts.name}`, version: VERSION });

  const requestInit = (() => {
    if (opts.transport.type === "stdio") return undefined;
    if (!opts.transport.headers || Object.keys(opts.transport.headers).length === 0)
      return undefined;
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
        const rawEntry = entry as typeof entry & Record<string, unknown>;
        const name = typeof entry.name === "string" ? entry.name : "";
        if (!name) continue;
        const description = capMcpDescription(
          typeof entry.description === "string" ? entry.description : `MCP tool ${name}`,
        );
        discovered[name] = {
          description,
          inputSchema: normalizeMcpJsonSchema(
            entry.inputSchema ?? {
              type: "object",
              properties: {},
              additionalProperties: true,
            },
            true,
          ),
          ...(entry.annotations ? { annotations: entry.annotations } : {}),
          ...(entry._meta ? { _meta: entry._meta } : {}),
          ...(typeof rawEntry.connector_id === "string"
            ? { connectorId: rawEntry.connector_id }
            : {}),
          ...(typeof rawEntry.connector_name === "string"
            ? { connectorName: rawEntry.connector_name }
            : {}),
          execute: async (input: unknown) => {
            const meta = normalizeToolMeta(entry._meta);
            const params: CallToolRequest["params"] = {
              name,
              arguments: normalizeToolArguments(input),
              ...(meta ? { _meta: meta } : {}),
            };
            return await client.callTool(params);
          },
        };
      }
      return discovered;
    },
    close: async () => {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
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

function toStoredOAuthTokens(
  tokens: z.infer<typeof oauthProviderTokensSchema>,
): Omit<MCPServerOAuthTokens, "updatedAt"> {
  const expiresAt = (() => {
    if (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in))
      return undefined;
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
      throw new Error(
        `MCP server "${opts.server.name}" requires interactive OAuth re-authorization.`,
      );
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
        ...(latestClientInfo.clientSecret ? { client_secret: latestClientInfo.clientSecret } : {}),
        ...(latestClientInfo.tokenEndpointAuthMethod
          ? { token_endpoint_auth_method: latestClientInfo.tokenEndpointAuthMethod }
          : {}),
        ...(latestClientInfo.redirectUris?.length
          ? { redirect_uris: [...latestClientInfo.redirectUris] }
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
        ...(parsedInfo.data.token_endpoint_auth_method
          ? { tokenEndpointAuthMethod: parsedInfo.data.token_endpoint_auth_method }
          : {}),
        ...(parsedInfo.data.redirect_uris?.length
          ? { redirectUris: [...parsedInfo.data.redirect_uris] }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      try {
        await setMCPServerOAuthClientInformation({
          config: opts.config,
          server: opts.server,
          clientInformation: {
            clientId,
            ...(clientSecret ? { clientSecret } : {}),
            ...(parsedInfo.data.token_endpoint_auth_method
              ? { tokenEndpointAuthMethod: parsedInfo.data.token_endpoint_auth_method }
              : {}),
            ...(parsedInfo.data.redirect_uris?.length
              ? { redirectUris: [...parsedInfo.data.redirect_uris] }
              : {}),
          },
        });
      } catch {
        // best effort persistence only
      }
    },
  };
}

async function hydrateServerForRuntime(
  config: AgentConfig,
  server: MCPRegistryServer,
): Promise<MCPServerConfig> {
  const auth = await resolveMCPServerAuthState(config, server);

  if (server.transport.type === "http" || server.transport.type === "sse") {
    const existingHeaders = server.transport.headers ?? {};
    const mergedHeaders = auth.headers ? { ...existingHeaders, ...auth.headers } : existingHeaders;
    const runtimeTransport: RuntimeMcpHttpTransport = {
      ...server.transport,
      ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
    };

    const runtimeServer: MCPServerConfig = {
      name: server.name,
      required: server.required,
      retries: server.retries,
      auth: server.auth,
      transport: runtimeTransport,
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
        runtimeTransport.authProvider = provider;
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

export async function loadMCPServerForValidation(
  config: AgentConfig,
  server: MCPRegistryServer,
): Promise<MCPServerConfig | null> {
  if (server.enabled === false) return null;
  return await hydrateServerForRuntime(config, server);
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
    warnings: registry.warnings,
  };
}

/**
 * A workspace's own `.cowork/mcp-servers.json` is attacker-controlled in a
 * malicious repository, so none of its MCP servers may auto-start unless the
 * workspace is explicitly trusted (resolved only from env/user config — never
 * from the workspace itself). Both transports are dangerous on repo open:
 *  - stdio launches a local command with the agent's privileges BEFORE the
 *    bash/tool command-approval path runs.
 *  - http/sse silently opens an outbound connection to a workspace-specified URL
 *    and forwards every tool invocation (which may carry file contents, secrets,
 *    or PII read earlier in the turn) to it, optionally with user-config auth
 *    headers — a drive-by exfiltration/SSRF channel.
 * Other sources (user/system/plugin) are installed deliberately; only
 * workspace-owned servers (including workspace-scoped plugin bundles, which ship
 * inside the repo) are gated.
 */
function isUntrustedWorkspaceServer(
  server: MCPRegistryServer,
  config: AgentConfig,
  allowUntrusted: boolean,
): boolean {
  if (config.trustWorkspaceMcp === true || allowUntrusted) return false;
  const isWorkspaceOwned =
    server.source === "workspace" ||
    (server.source === "plugin" && server.pluginScope === "workspace");
  return isWorkspaceOwned;
}

export async function loadMCPServers(
  config: AgentConfig,
  opts: {
    log?: (line: string) => void;
    /**
     * Allow this call to include the workspace's own (otherwise untrusted) MCP
     * servers. Reserved for explicit, user-initiated actions (e.g. MCP server
     * validation), which serve as per-command approval. The automatic turn-setup
     * path leaves this false so a malicious workspace cannot auto-launch commands
     * or auto-connect to its own endpoints.
     */
    includeUntrustedWorkspace?: boolean;
  } = {},
): Promise<MCPServerConfig[]> {
  const registry = await loadMCPConfigRegistry(config);
  const allowed: MCPRegistryServer[] = [];
  for (const server of registry.servers) {
    if (server.enabled === false) continue;
    if (isUntrustedWorkspaceServer(server, config, opts.includeUntrustedWorkspace === true)) {
      const action =
        server.transport.type === "stdio"
          ? "launch local commands"
          : "connect to its own network endpoints";
      opts.log?.(
        `[MCP] Not auto-starting workspace ${server.transport.type} server "${server.name}" from ` +
          `.cowork/${MCP_SERVERS_FILE_NAME}: this workspace is not trusted to ${action}. ` +
          `Set "trustWorkspaceMcp": true in ~/.cowork/config/config.json or ` +
          `AGENT_TRUST_WORKSPACE_MCP=1 to allow it.`,
      );
      continue;
    }
    allowed.push(server);
  }
  const hydrated = await Promise.all(
    allowed.map(async (server) => await hydrateServerForRuntime(config, server)),
  );
  if (!hydrated.some((server) => server.name === CODEX_APPS_MCP_SERVER_NAME)) {
    const codexApps = await buildCodexAppsMcpServer(config);
    if (codexApps) {
      hydrated.push(codexApps);
    }
  }
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

export async function writeProjectMCPServersDocument(
  projectCoworkDir: string,
  rawJson: string,
): Promise<void> {
  parseMCPServersDocument(rawJson);
  const workspaceCoworkDir = projectCoworkDir;
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
  servers: RuntimeMcpServerConfig[],
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
        // Intentionally silent: one client's close failure must not block
        // closing the remaining clients during teardown.
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

        const enabledConnectorIds =
          server.name === CODEX_APPS_MCP_SERVER_NAME
            ? new Set(server.enabledConnectorIds ?? [])
            : null;
        for (const [name, toolDef] of Object.entries(discovered)) {
          if (enabledConnectorIds && enabledConnectorIds.size > 0) {
            const record =
              typeof toolDef === "object" && toolDef !== null
                ? (toolDef as Record<string, unknown>)
                : {};
            const meta =
              typeof record._meta === "object" && record._meta !== null
                ? (record._meta as Record<string, unknown>)
                : {};
            const connectorId =
              typeof record.connectorId === "string"
                ? record.connectorId
                : typeof meta.connector_id === "string"
                  ? meta.connector_id
                  : undefined;
            if (!connectorId || !enabledConnectorIds.has(connectorId)) {
              continue;
            }
          }
          const toolKey = reserveMcpToolName(tools, server.name, name, opts.log);
          tools[toolKey] = toolDef;
        }

        clients.push({ name: server.name, close: client.close.bind(client) });

        opts.log?.(`[MCP] Connected to ${server.name}: ${Object.keys(discovered).length} tools`);
        break;
      } catch (error) {
        try {
          await client?.close?.();
        } catch {
          // Intentionally silent: the connection error below is the real
          // failure; a close error during its cleanup is noise.
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

function reserveMcpToolName(
  tools: Record<string, unknown>,
  serverName: string,
  toolName: string,
  log?: (line: string) => void,
): string {
  const baseName = buildMcpToolName(serverName, toolName);
  if (!(baseName in tools)) return baseName;

  let i = 2;
  let candidate = `${baseName}_${i}`;
  while (candidate in tools) {
    i += 1;
    candidate = `${baseName}_${i}`;
  }
  log?.(
    `[MCP warn] Tool name collision: "${serverName}/${toolName}" remapped to "${candidate}" — reference it by the remapped name`,
  );
  return candidate;
}

interface CachedWorkspaceMcp {
  serversConfigJson: string;
  tools: Record<string, unknown>;
  errors: string[];
  close: () => Promise<void>;
  sessionIds: Set<string>;
}

const workspaceMcpCache = new Map<string, CachedWorkspaceMcp>();

function serializeServerConfigs(servers: MCPServerConfig[]): string {
  try {
    const cloned = JSON.parse(
      JSON.stringify(servers, (_key, value) => {
        if (typeof value === "function") return undefined;
        return value;
      }),
    );
    return JSON.stringify(cloned);
  } catch {
    return "";
  }
}

export async function getOrLoadMCPToolsCached(
  config: AgentConfig,
  sessionId: string,
  opts: {
    log?: (line: string) => void;
    loadMCPServers?: typeof loadMCPServers;
    loadMCPTools?: typeof loadMCPTools;
  } = {},
): Promise<{ tools: Record<string, unknown>; errors: string[] }> {
  const loadMCPServersFn = opts.loadMCPServers ?? loadMCPServers;
  const loadMCPToolsFn = opts.loadMCPTools ?? loadMCPTools;

  const workspaceKey = path.resolve(config.projectCoworkDir);
  const servers = await loadMCPServersFn(config, { log: opts.log });
  const serversConfigJson = serializeServerConfigs(servers);

  const cached = workspaceMcpCache.get(workspaceKey);

  if (cached) {
    if (cached.serversConfigJson === serversConfigJson) {
      cached.sessionIds.add(sessionId);
      return { tools: cached.tools, errors: cached.errors };
    }

    opts.log?.(`[MCP] Server configuration changed for workspace ${workspaceKey}. Reloading...`);
    try {
      await cached.close();
    } catch (error) {
      opts.log?.(
        `[MCP] Error closing stale MCP cache for workspace ${workspaceKey}: ${String(error)}`,
      );
    }
    workspaceMcpCache.delete(workspaceKey);
  }

  let loaded: { tools: Record<string, unknown>; errors: string[]; close: () => Promise<void> } = {
    tools: {},
    errors: [],
    close: async () => {},
  };

  if (servers.length > 0) {
    loaded = await loadMCPToolsFn(servers, { log: opts.log });
  }

  const newCacheEntry: CachedWorkspaceMcp = {
    serversConfigJson,
    tools: loaded.tools,
    errors: loaded.errors,
    close: loaded.close,
    sessionIds: new Set([sessionId]),
  };

  workspaceMcpCache.set(workspaceKey, newCacheEntry);
  return { tools: loaded.tools, errors: loaded.errors };
}

export async function closeMcpServersForSession(sessionId: string): Promise<void> {
  for (const [workspaceKey, cached] of workspaceMcpCache.entries()) {
    if (cached.sessionIds.has(sessionId)) {
      cached.sessionIds.delete(sessionId);
      if (cached.sessionIds.size === 0) {
        try {
          await cached.close();
        } catch (error) {
          // Session teardown has no log channel; keep the failure visible in server logs.
          console.warn(
            `[MCP] Error closing MCP servers for workspace ${workspaceKey}: ${String(error)}`,
          );
        }
        workspaceMcpCache.delete(workspaceKey);
      }
    }
  }
}

export const __internal = {
  normalizeMcpJsonSchema,
  workspaceMcpCache,
};
