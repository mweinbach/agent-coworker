import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
  mcpAuthChallengeEventSchema,
  mcpAuthResultEventSchema,
  mcpServersEventSchema,
  mcpValidationEventSchema,
} from "../../shared/jsonrpcControlSchemas";

export const jsonRpcMcpRequestSchemas = {
  "cowork/mcp/servers/read": jsonRpcControlRequestSchemas["cowork/mcp/servers/read"],
  "cowork/mcp/server/upsert": jsonRpcControlRequestSchemas["cowork/mcp/server/upsert"],
  "cowork/mcp/server/delete": jsonRpcControlRequestSchemas["cowork/mcp/server/delete"],
  "cowork/mcp/server/validate": jsonRpcControlRequestSchemas["cowork/mcp/server/validate"],
  "cowork/mcp/server/auth/authorize": jsonRpcControlRequestSchemas["cowork/mcp/server/auth/authorize"],
  "cowork/mcp/server/auth/callback": jsonRpcControlRequestSchemas["cowork/mcp/server/auth/callback"],
  "cowork/mcp/server/auth/setApiKey": jsonRpcControlRequestSchemas["cowork/mcp/server/auth/setApiKey"],
  "cowork/mcp/legacy/migrate": jsonRpcControlRequestSchemas["cowork/mcp/legacy/migrate"],
} as const;

export const jsonRpcMcpResultSchemas = {
  "cowork/mcp/servers/read": jsonRpcControlResultSchemas["cowork/mcp/servers/read"],
  "cowork/mcp/server/upsert": jsonRpcControlResultSchemas["cowork/mcp/server/upsert"],
  "cowork/mcp/server/delete": jsonRpcControlResultSchemas["cowork/mcp/server/delete"],
  "cowork/mcp/server/validate": jsonRpcControlResultSchemas["cowork/mcp/server/validate"],
  "cowork/mcp/server/auth/authorize": jsonRpcControlResultSchemas["cowork/mcp/server/auth/authorize"],
  "cowork/mcp/server/auth/callback": jsonRpcControlResultSchemas["cowork/mcp/server/auth/callback"],
  "cowork/mcp/server/auth/setApiKey": jsonRpcControlResultSchemas["cowork/mcp/server/auth/setApiKey"],
  "cowork/mcp/legacy/migrate": jsonRpcControlResultSchemas["cowork/mcp/legacy/migrate"],
} as const;
