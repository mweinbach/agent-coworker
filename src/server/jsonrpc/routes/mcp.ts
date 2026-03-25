import type { ServerEvent } from "../../protocol";

import {
  captureWorkspaceControlMutationError,
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createMcpRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/mcp/servers/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.emitMcpServers(),
        (event): event is Extract<ServerEvent, { type: "mcp_servers" }> => event.type === "mcp_servers",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/mcp/server/upsert": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const server = params.server as any;
      const previousName = typeof params.previousName === "string" ? params.previousName : undefined;
      const mutationError = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (session) => await session.upsertMcpServer(server, previousName),
      );
      if (mutationError) {
        sendSessionMutationError(context, ws, message.id, mutationError);
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.emitMcpServers(),
        (event): event is Extract<ServerEvent, { type: "mcp_servers" }> => event.type === "mcp_servers",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/mcp/server/delete": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const mutationError = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (session) => await session.deleteMcpServer(name),
      );
      if (mutationError) {
        sendSessionMutationError(context, ws, message.id, mutationError);
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.emitMcpServers(),
        (event): event is Extract<ServerEvent, { type: "mcp_servers" }> => event.type === "mcp_servers",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/mcp/server/validate": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.validateMcpServer(name),
        (event): event is Extract<ServerEvent, { type: "mcp_server_validation" }> =>
          event.type === "mcp_server_validation" && event.name === name,
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/mcp/server/auth/authorize": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.authorizeMcpServerAuth(name),
        (event): event is Extract<ServerEvent, { type: "mcp_server_auth_challenge" | "mcp_server_auth_result" }> => (
          (event.type === "mcp_server_auth_challenge" || event.type === "mcp_server_auth_result")
          && event.name === name
        ),
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/mcp/server/auth/callback": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const code = typeof params.code === "string" && params.code.trim() ? params.code.trim() : undefined;
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.callbackMcpServerAuth(name, code),
        (event): event is Extract<ServerEvent, { type: "mcp_server_auth_result" }> =>
          event.type === "mcp_server_auth_result" && event.name === name,
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/mcp/server/auth/setApiKey": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.setMcpServerApiKey(name, apiKey),
        (event): event is Extract<ServerEvent, { type: "mcp_server_auth_result" }> =>
          event.type === "mcp_server_auth_result" && event.name === name,
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/mcp/legacy/migrate": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const scope = params.scope === "user" ? "user" : "workspace";
      const mutationError = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (session) => await session.migrateLegacyMcpServers(scope),
      );
      if (mutationError) {
        sendSessionMutationError(context, ws, message.id, mutationError);
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.emitMcpServers(),
        (event): event is Extract<ServerEvent, { type: "mcp_servers" }> => event.type === "mcp_servers",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },
  };
}
