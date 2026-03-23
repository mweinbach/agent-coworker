import { JSONRPC_ERROR_CODES } from "../protocol";

import { createAgentRouteHandlers } from "./agents";
import { createMcpRouteHandlers } from "./mcp";
import { createMemoryRouteHandlers } from "./memory";
import { createProviderRouteHandlers } from "./provider";
import { createSessionRouteHandlers } from "./session";
import { createSkillsRouteHandlers } from "./skills";
import { createThreadRouteHandlers } from "./thread";
import { createTurnRouteHandlers } from "./turn";
import { createWorkspaceBackupRouteHandlers } from "./workspaceBackups";
import type { JsonRpcRequestHandler, JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export type { JsonRpcRequestHandler, JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createJsonRpcRequestRouter(context: JsonRpcRouteContext): JsonRpcRequestHandler {
  const handlers: JsonRpcRequestHandlerMap = {
    ...createThreadRouteHandlers(context),
    ...createTurnRouteHandlers(context),
    ...createSessionRouteHandlers(context),
    ...createAgentRouteHandlers(context),
    ...createProviderRouteHandlers(context),
    ...createMcpRouteHandlers(context),
    ...createSkillsRouteHandlers(context),
    ...createMemoryRouteHandlers(context),
    ...createWorkspaceBackupRouteHandlers(context),
  };

  return async (ws, message) => {
    const handler = handlers[message.method];
    if (!handler) {
      context.jsonrpc.sendError(ws, message.id, {
        code: JSONRPC_ERROR_CODES.methodNotFound,
        message: `Unknown method: ${message.method}`,
      });
      return;
    }

    await handler(ws, message);
  };
}
