import type { ServerEvent } from "../../protocol";

import {
  captureWorkspaceControlMutationError,
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createPluginsRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/plugins/catalog/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.getPluginsCatalog(),
        (event): event is Extract<ServerEvent, { type: "plugins_catalog" }> => event.type === "plugins_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/plugins/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const pluginId = typeof params.pluginId === "string" ? params.pluginId.trim() : "";
      const scope = params.scope === "workspace" || params.scope === "user" ? params.scope : undefined;
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.getPlugin(pluginId, scope),
        (event): event is Extract<ServerEvent, { type: "plugin_detail" }> =>
          event.type === "plugin_detail",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/plugins/install/preview": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const sourceInput = typeof params.sourceInput === "string" ? params.sourceInput : "";
      const targetScope = params.targetScope === "user" ? "user" : "workspace";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.previewPluginInstall(sourceInput, targetScope),
        (event): event is Extract<ServerEvent, { type: "plugin_install_preview" }> =>
          event.type === "plugin_install_preview",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/plugins/install": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const sourceInput = typeof params.sourceInput === "string" ? params.sourceInput : "";
      const targetScope = params.targetScope === "user" ? "user" : "workspace";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.installPlugins(sourceInput, targetScope),
        (event): event is Extract<ServerEvent, { type: "plugins_catalog" }> => event.type === "plugins_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/plugins/enable": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const pluginId = typeof params.pluginId === "string" ? params.pluginId.trim() : "";
      const scope = params.scope === "workspace" || params.scope === "user" ? params.scope : undefined;
      const outcome = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (session) => await session.enablePlugin(pluginId, scope),
      );
      if (outcome) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.getPluginsCatalog(),
        (nextEvent): nextEvent is Extract<ServerEvent, { type: "plugins_catalog" }> => nextEvent.type === "plugins_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/plugins/disable": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const pluginId = typeof params.pluginId === "string" ? params.pluginId.trim() : "";
      const scope = params.scope === "workspace" || params.scope === "user" ? params.scope : undefined;
      const outcome = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (session) => await session.disablePlugin(pluginId, scope),
      );
      if (outcome) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.getPluginsCatalog(),
        (nextEvent): nextEvent is Extract<ServerEvent, { type: "plugins_catalog" }> => nextEvent.type === "plugins_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}
