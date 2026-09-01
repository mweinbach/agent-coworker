import type { McpUpsertServer } from "./mcpStore";

export type McpServerDraft = {
  original?: McpUpsertServer;
  name: string;
  transportType: "stdio" | "http" | "sse";
  command: string;
  args: string;
  cwd: string;
  url: string;
  required: boolean;
  authType: "none" | "api_key" | "oauth";
  headerName: string;
  prefix: string;
  oauthMode: "auto" | "code";
  scope: string;
  resource: string;
};

export function emptyMcpServerDraft(): McpServerDraft {
  return {
    name: "",
    transportType: "stdio",
    command: "",
    args: "",
    cwd: "",
    url: "",
    required: false,
    authType: "none",
    headerName: "",
    prefix: "",
    oauthMode: "auto",
    scope: "",
    resource: "",
  };
}

export function draftFromServer(server: McpUpsertServer): McpServerDraft {
  const {
    source: _source,
    inherited: _inherited,
    authMode: _authMode,
    authScope: _authScope,
    authMessage: _authMessage,
    pluginId: _pluginId,
    pluginName: _pluginName,
    pluginDisplayName: _pluginDisplayName,
    pluginScope: _pluginScope,
    ...original
  } = server;
  return {
    original,
    name: server.name,
    transportType: server.transport.type,
    command: server.transport.type === "stdio" ? server.transport.command : "",
    args:
      server.transport.type === "stdio" && server.transport.args
        ? JSON.stringify(server.transport.args)
        : "",
    cwd: server.transport.type === "stdio" ? (server.transport.cwd ?? "") : "",
    url: server.transport.type === "stdio" ? "" : server.transport.url,
    required: Boolean(server.required),
    authType: server.auth?.type ?? "none",
    headerName: server.auth?.type === "api_key" ? (server.auth.headerName ?? "") : "",
    prefix: server.auth?.type === "api_key" ? (server.auth.prefix ?? "") : "",
    oauthMode: server.auth?.type === "oauth" ? (server.auth.oauthMode ?? "auto") : "auto",
    scope: server.auth?.type === "oauth" ? (server.auth.scope ?? "") : "",
    resource: server.auth?.type === "oauth" ? (server.auth.resource ?? "") : "",
  };
}

function parseArguments(value: string): string[] | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((argument) => typeof argument === "string")) {
      return parsed;
    }
  } catch {
    // Report one actionable error for invalid JSON and invalid argument shapes.
  }
  throw new Error("Arguments must be a JSON array of strings.");
}

export function toServerConfig(draft: McpServerDraft): McpUpsertServer {
  const originalTransport = draft.original?.transport;
  const originalAuth = draft.original?.auth;
  return {
    ...draft.original,
    name: draft.name.trim(),
    required: draft.required,
    transport:
      draft.transportType === "stdio"
        ? {
            ...(originalTransport?.type === "stdio" ? originalTransport : {}),
            type: "stdio",
            command: draft.command.trim(),
            args: parseArguments(draft.args),
            cwd: draft.cwd.trim() || undefined,
          }
        : {
            ...(originalTransport && originalTransport.type !== "stdio" ? originalTransport : {}),
            type: draft.transportType,
            url: draft.url.trim(),
          },
    auth:
      draft.authType === "api_key"
        ? {
            ...(originalAuth?.type === "api_key" ? originalAuth : {}),
            type: "api_key",
            headerName: draft.headerName.trim() || undefined,
            prefix: draft.prefix || undefined,
          }
        : draft.authType === "oauth"
          ? {
              ...(originalAuth?.type === "oauth" ? originalAuth : {}),
              type: "oauth",
              oauthMode: draft.oauthMode,
              scope: draft.scope.trim() || undefined,
              resource: draft.resource.trim() || undefined,
            }
          : { type: "none" },
  };
}
