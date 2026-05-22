import { loadConfig } from "../../../config";
import { resolveOpenAiNativeConnectorsConfig } from "../../../experimental/openaiNativeConnectors/flags";
import { OPENAI_NATIVE_CONNECTORS_EVENT_TYPE } from "../../../shared/openaiNativeConnectors";
import {
  listOpenAiNativeConnectors,
  setOpenAiNativeConnectorEnabled,
} from "../../connectors/openaiNativeConnectors";
import { JSONRPC_ERROR_CODES } from "../protocol";

import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createConnectorsRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  async function emitConnectorList(
    cwd: string,
    sessionId: string,
    opts: { connectorId?: string; enabled?: boolean; forceRefetch?: boolean } = {},
  ) {
    const config = await loadConfig({ cwd });
    if (!resolveOpenAiNativeConnectorsConfig(config)) {
      const snapshot = await listOpenAiNativeConnectors({
        config,
        forceRefetch: opts.forceRefetch,
      });
      return {
        type: OPENAI_NATIVE_CONNECTORS_EVENT_TYPE,
        sessionId,
        connectors: snapshot.connectors,
        enabledConnectorIds: snapshot.enabledConnectorIds,
        authenticated: snapshot.authenticated,
        ...(snapshot.message ? { message: snapshot.message } : {}),
      };
    }
    if (opts.connectorId) {
      await setOpenAiNativeConnectorEnabled(config, opts.connectorId, opts.enabled === true);
    }
    const snapshot = await listOpenAiNativeConnectors({ config, forceRefetch: opts.forceRefetch });
    return {
      type: OPENAI_NATIVE_CONNECTORS_EVENT_TYPE,
      sessionId,
      connectors: snapshot.connectors,
      enabledConnectorIds: snapshot.enabledConnectorIds,
      authenticated: snapshot.authenticated,
      ...(snapshot.message ? { message: snapshot.message } : {}),
    };
  }

  return {
    "cowork/connectors/openai-native/list": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      try {
        const event = await context.workspaceControl.withSession(
          cwd,
          async (_binding, runtime) =>
            await emitConnectorList(cwd, runtime.read.id, { forceRefetch: true }),
        );
        context.jsonrpc.sendResult(ws, message.id, { event });
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.internalError,
          message: String(error),
        });
      }
    },

    "cowork/connectors/openai-native/refresh": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      try {
        const event = await context.workspaceControl.withSession(
          cwd,
          async (_binding, runtime) => await emitConnectorList(cwd, runtime.read.id),
        );
        context.jsonrpc.sendResult(ws, message.id, { event });
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.internalError,
          message: String(error),
        });
      }
    },

    "cowork/connectors/openai-native/setEnabled": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const connectorId = typeof params.connectorId === "string" ? params.connectorId.trim() : "";
      if (!connectorId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires connectorId`,
        });
        return;
      }
      try {
        const event = await context.workspaceControl.withSession(
          cwd,
          async (_binding, runtime) =>
            await emitConnectorList(cwd, runtime.read.id, {
              connectorId,
              enabled: params.enabled === true,
            }),
        );
        context.jsonrpc.sendResult(ws, message.id, { event });
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.internalError,
          message: String(error),
        });
      }
    },
  };
}
