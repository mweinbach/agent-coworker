import { pickJsonRpcControlSchemas } from "../../shared/jsonrpcControlSchemas";

const mcpControlSchemas = pickJsonRpcControlSchemas([
  "cowork/mcp/servers/read",
  "cowork/mcp/server/upsert",
  "cowork/mcp/server/delete",
  "cowork/mcp/server/setEnabled",
  "cowork/mcp/server/validate",
  "cowork/mcp/server/auth/authorize",
  "cowork/mcp/server/auth/callback",
  "cowork/mcp/server/auth/setApiKey",
] as const);

export const jsonRpcMcpRequestSchemas = mcpControlSchemas.requests;

export const jsonRpcMcpResultSchemas = mcpControlSchemas.results;
