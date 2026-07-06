import type { MCPServerSource } from "../../../mcp/configRegistry";
import type { SessionEvent } from "../../protocol";
import type { McpServerLookup } from "../../session/mcp/McpServerLookup";

import {
  captureWorkspaceControlMutationError,
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

function resolveEditableMcpSource(value: unknown): "workspace" | "user" {
  return value === "user" ? "user" : "workspace";
}

function resolveMcpSource(value: unknown): MCPServerSource | undefined {
  if (value === "workspace" || value === "user" || value === "plugin" || value === "system") {
    return value;
  }
  return undefined;
}

function resolveMcpServerLookup(params: Record<string, unknown>): McpServerLookup | undefined {
  const source = resolveMcpSource(params.source);
  const pluginId = typeof params.pluginId === "string" ? params.pluginId.trim() : undefined;
  const pluginScope: McpServerLookup["pluginScope"] =
    params.pluginScope === "workspace" || params.pluginScope === "user"
      ? params.pluginScope
      : undefined;
  const lookup = {
    ...(source ? { source } : {}),
    ...(pluginId ? { pluginId } : {}),
    ...(pluginScope ? { pluginScope } : {}),
  };
  return Object.keys(lookup).length > 0 ? lookup : undefined;
}

export function createMcpRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
  return {
    "cowork/mcp/servers/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.mcp.emitServers(),
        (event): event is Extract<SessionEvent, { type: "mcp_servers" }> =>
          event.type === "mcp_servers",
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
      const previousName =
        typeof params.previousName === "string" ? params.previousName : undefined;
      const source = resolveEditableMcpSource(params.source);
      const mutationError = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (runtime) => await runtime.mcp.upsert(server, previousName, source),
      );
      if (mutationError) {
        sendSessionMutationError(context, ws, message.id, mutationError);
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.mcp.emitServers(),
        (event): event is Extract<SessionEvent, { type: "mcp_servers" }> =>
          event.type === "mcp_servers",
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
      const source = resolveEditableMcpSource(params.source);
      const mutationError = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (runtime) => await runtime.mcp.delete(name, source),
      );
      if (mutationError) {
        sendSessionMutationError(context, ws, message.id, mutationError);
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.mcp.emitServers(),
        (event): event is Extract<SessionEvent, { type: "mcp_servers" }> =>
          event.type === "mcp_servers",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/mcp/server/setEnabled": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const name = typeof params.name === "string" ? params.name.trim() : "";
      const source = typeof params.source === "string" ? params.source : "";
      const enabled = params.enabled === true;
      const pluginId = typeof params.pluginId === "string" ? params.pluginId.trim() : undefined;
      const pluginScope =
        params.pluginScope === "workspace" || params.pluginScope === "user"
          ? params.pluginScope
          : undefined;
      const mutationError = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (runtime) =>
          await runtime.mcp.setEnabled({
            name,
            source: source as "workspace" | "user" | "plugin" | "system",
            enabled,
            pluginId,
            pluginScope,
          }),
      );
      if (mutationError) {
        sendSessionMutationError(context, ws, message.id, mutationError);
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.mcp.emitServers(),
        (event): event is Extract<SessionEvent, { type: "mcp_servers" }> =>
          event.type === "mcp_servers",
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
      const lookup = resolveMcpServerLookup(params);
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.mcp.validate(name, lookup),
        (event): event is Extract<SessionEvent, { type: "mcp_server_validation" }> =>
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
      const lookup = resolveMcpServerLookup(params);
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.mcp.authorizeAuth(name, lookup),
        (
          event,
        ): event is Extract<
          SessionEvent,
          { type: "mcp_server_auth_challenge" | "mcp_server_auth_result" }
        > =>
          (event.type === "mcp_server_auth_challenge" || event.type === "mcp_server_auth_result") &&
          event.name === name,
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
      const lookup = resolveMcpServerLookup(params);
      const code =
        typeof params.code === "string" && params.code.trim() ? params.code.trim() : undefined;
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.mcp.callbackAuth(name, code, lookup),
        (event): event is Extract<SessionEvent, { type: "mcp_server_auth_result" }> =>
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
      const lookup = resolveMcpServerLookup(params);
      const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.mcp.setApiKey(name, apiKey, lookup),
        (event): event is Extract<SessionEvent, { type: "mcp_server_auth_result" }> =>
          event.type === "mcp_server_auth_result" && event.name === name,
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },
  };
}
