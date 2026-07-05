import { resolveTasksFeatureEnabled } from "../../tasks/flags";
import { JSONRPC_ERROR_CODES } from "../protocol";

import { createAgentProfilesRouteHandlers } from "./agentProfiles";
import { createAgentRouteHandlers } from "./agents";
import { createCommandRouteHandlers } from "./commands";
import { createConnectorsRouteHandlers } from "./connectors";
import { createImportRouteHandlers } from "./import";
import { createMarketplacesRouteHandlers } from "./marketplaces";
import { createMcpRouteHandlers } from "./mcp";
import { createMemoryRouteHandlers } from "./memory";
import { createPluginsRouteHandlers } from "./plugins";
import { createProviderRouteHandlers } from "./provider";
import { createResearchRouteHandlers } from "./research";
import { createRuntimeRouteHandlers } from "./runtime";
import { createSessionRouteHandlers } from "./session";
import { createSkillsRouteHandlers } from "./skills";
import { createTaskRouteHandlers } from "./tasks";
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
    ...createAgentProfilesRouteHandlers(context),
    ...createConnectorsRouteHandlers(context),
    ...createCommandRouteHandlers(context),
    ...createProviderRouteHandlers(context),
    ...createRuntimeRouteHandlers(context),
    ...createResearchRouteHandlers(context),
    ...createMcpRouteHandlers(context),
    ...createPluginsRouteHandlers(context),
    ...createSkillsRouteHandlers(context),
    ...createMarketplacesRouteHandlers(context),
    ...createImportRouteHandlers(context),
    ...createMemoryRouteHandlers(context),
    ...createWorkspaceBackupRouteHandlers(context),
    ...createWorkspaceRouteHandlers(context),
    // Gate the durable Tasks routes behind the `tasks` feature flag. When off,
    // task/* methods are unregistered and resolve to methodNotFound below.
    ...(resolveTasksFeatureEnabled(context.getConfig()) ? createTaskRouteHandlers(context) : {}),
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
