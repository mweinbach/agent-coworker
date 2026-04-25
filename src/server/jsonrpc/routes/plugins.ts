import type { SessionEvent } from "../../protocol";

import {
  captureWorkspaceControlMutationEvents,
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

type PluginMutationResponseEvent = Extract<
  SessionEvent,
  { type: "skills_list" | "skills_catalog" | "plugins_catalog" | "mcp_servers" }
>;
type PluginInstallResponseEvent =
  | PluginMutationResponseEvent
  | Extract<SessionEvent, { type: "plugin_install_preview" | "plugin_detail" }>;
const PLUGIN_INSTALL_EVENTS_TIMEOUT_MS = 60_000;

function isPluginMutationResponseEvent(event: SessionEvent): event is PluginMutationResponseEvent {
  return (
    event.type === "skills_list" ||
    event.type === "skills_catalog" ||
    event.type === "plugins_catalog" ||
    event.type === "mcp_servers"
  );
}

function isPluginInstallResponseEvent(event: SessionEvent): event is PluginInstallResponseEvent {
  return (
    isPluginMutationResponseEvent(event) ||
    event.type === "plugin_install_preview" ||
    event.type === "plugin_detail"
  );
}

export function createPluginsRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
  return {
    "cowork/plugins/catalog/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.getPluginsCatalog(),
        (event): event is Extract<SessionEvent, { type: "plugins_catalog" }> =>
          event.type === "plugins_catalog",
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
      const scope =
        params.scope === "workspace" || params.scope === "user" ? params.scope : undefined;
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.getPlugin(pluginId, scope),
        (event): event is Extract<SessionEvent, { type: "plugin_detail" }> =>
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
        (event): event is Extract<SessionEvent, { type: "plugin_install_preview" }> =>
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
      const events = await captureWorkspaceControlMutationEvents(
        context,
        cwd,
        async (session) => await session.installPlugins(sourceInput, targetScope),
        isPluginInstallResponseEvent,
        { timeoutMs: PLUGIN_INSTALL_EVENTS_TIMEOUT_MS },
      );
      const error = events.find(context.utils.isSessionError);
      if (error) {
        sendSessionMutationError(context, ws, message.id, error);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { events });
    },

    "cowork/plugins/enable": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const pluginId = typeof params.pluginId === "string" ? params.pluginId.trim() : "";
      const scope =
        params.scope === "workspace" || params.scope === "user" ? params.scope : undefined;
      const events = await captureWorkspaceControlMutationEvents(
        context,
        cwd,
        async (session) => await session.enablePlugin(pluginId, scope),
        isPluginMutationResponseEvent,
      );
      const error = events.find(context.utils.isSessionError);
      if (error) {
        sendSessionMutationError(context, ws, message.id, error);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { events });
    },

    "cowork/plugins/disable": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const pluginId = typeof params.pluginId === "string" ? params.pluginId.trim() : "";
      const scope =
        params.scope === "workspace" || params.scope === "user" ? params.scope : undefined;
      const events = await captureWorkspaceControlMutationEvents(
        context,
        cwd,
        async (session) => await session.disablePlugin(pluginId, scope),
        isPluginMutationResponseEvent,
      );
      const error = events.find(context.utils.isSessionError);
      if (error) {
        sendSessionMutationError(context, ws, message.id, error);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { events });
    },
  };
}
