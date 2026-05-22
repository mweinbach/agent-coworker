import { JSONRPC_ERROR_CODES } from "../protocol";

import { createAgentRouteHandlers } from "./agents";
import { createConnectorsRouteHandlers } from "./connectors";
import { createMcpRouteHandlers } from "./mcp";
import { createMemoryRouteHandlers } from "./memory";
import { createPluginsRouteHandlers } from "./plugins";
import { createProviderRouteHandlers } from "./provider";
import { createResearchRouteHandlers } from "./research";
import { createRuntimeRouteHandlers } from "./runtime";
import { createSessionRouteHandlers } from "./session";
import { createSkillsRouteHandlers } from "./skills";
import { createThreadRouteHandlers } from "./thread";
import { createTurnRouteHandlers } from "./turn";
import type { JsonRpcRequestHandler, JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";
import { createWorkspaceRouteHandlers } from "./workspace";
import { createWorkspaceBackupRouteHandlers } from "./workspaceBackups";

export type { JsonRpcRequestHandler, JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createJsonRpcRequestRouter(
  context: JsonRpcRouteContext,
  opts: { experimentalHandlers?: JsonRpcRequestHandlerMap } = {},
): JsonRpcRequestHandler {
  const handlers: JsonRpcRequestHandlerMap = {
    ...createThreadRouteHandlers(context),
    ...createTurnRouteHandlers(context),
    ...createSessionRouteHandlers(context),
    ...createAgentRouteHandlers(context),
    ...createConnectorsRouteHandlers(context),
    ...createProviderRouteHandlers(context),
    ...createRuntimeRouteHandlers(context),
    ...createResearchRouteHandlers(context),
    ...createMcpRouteHandlers(context),
    ...createPluginsRouteHandlers(context),
    ...createSkillsRouteHandlers(context),
    ...createMemoryRouteHandlers(context),
    ...createWorkspaceBackupRouteHandlers(context),
    ...createWorkspaceRouteHandlers(context),
    ...(opts.experimentalHandlers ?? {}),
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
