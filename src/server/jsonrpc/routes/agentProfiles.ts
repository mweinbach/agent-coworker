import type { SessionEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcAgentProfilesRequestSchemas } from "../schema.agentProfiles";

import {
  captureWorkspaceControlMutationError,
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createAgentProfilesRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/agentProfiles/catalog/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.agentProfiles.getCatalog(),
        isAgentProfilesCatalogEvent,
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/agentProfiles/upsert": async (ws, message) => {
      const parsed = jsonRpcAgentProfilesRequestSchemas["cowork/agentProfiles/upsert"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        sendInvalidParams(context, ws, message.id, message.method, parsed.error);
        return;
      }
      const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
      const mutationError = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (runtime) => await runtime.agentProfiles.upsert(parsed.data.profile),
      );
      if (mutationError) {
        sendSessionMutationError(context, ws, message.id, mutationError);
        return;
      }
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.agentProfiles.getCatalog(),
        isAgentProfilesCatalogEvent,
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/agentProfiles/delete": async (ws, message) => {
      const parsed = jsonRpcAgentProfilesRequestSchemas["cowork/agentProfiles/delete"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        sendInvalidParams(context, ws, message.id, message.method, parsed.error);
        return;
      }
      const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
      const mutationError = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (runtime) => await runtime.agentProfiles.delete(parsed.data.scope, parsed.data.id),
      );
      if (mutationError) {
        sendSessionMutationError(context, ws, message.id, mutationError);
        return;
      }
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.agentProfiles.getCatalog(),
        isAgentProfilesCatalogEvent,
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/agentProfiles/copy": async (ws, message) => {
      const parsed = jsonRpcAgentProfilesRequestSchemas["cowork/agentProfiles/copy"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        sendInvalidParams(context, ws, message.id, message.method, parsed.error);
        return;
      }
      const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
      const mutationError = await captureWorkspaceControlMutationError(
        context,
        cwd,
        async (runtime) => await runtime.agentProfiles.copy(parsed.data.copy),
      );
      if (mutationError) {
        sendSessionMutationError(context, ws, message.id, mutationError);
        return;
      }
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.agentProfiles.getCatalog(),
        isAgentProfilesCatalogEvent,
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}

function isAgentProfilesCatalogEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "agent_profiles_catalog" }> {
  return event.type === "agent_profiles_catalog";
}

function sendInvalidParams(
  context: JsonRpcRouteContext,
  ws: Parameters<JsonRpcRouteContext["jsonrpc"]["sendError"]>[0],
  id: Parameters<JsonRpcRouteContext["jsonrpc"]["sendError"]>[1],
  method: string,
  error: { issues: Array<{ message: string }> },
): void {
  const detail = error.issues[0]?.message;
  context.jsonrpc.sendError(ws, id, {
    code: JSONRPC_ERROR_CODES.invalidParams,
    message: detail ? `${method}: ${detail}` : `${method}: invalid params`,
  });
}
