import type { SessionEvent } from "../../protocol";

import { captureWorkspaceControlOutcome, sendSessionMutationError } from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

// Marketplace reads and mutations fetch remote manifests (and mutations trigger
// remote-inclusive catalog refreshes), so allow more than the default capture window.
const MARKETPLACE_EVENT_TIMEOUT_MS = 30_000;

function isMarketplacesListEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "marketplaces_list" }> {
  return event.type === "marketplaces_list";
}

export function createMarketplacesRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/marketplaces/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.skills.listMarketplaces(),
        isMarketplacesListEvent,
        MARKETPLACE_EVENT_TIMEOUT_MS,
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/marketplaces/add": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const sourceInput = typeof params.sourceInput === "string" ? params.sourceInput : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.skills.addMarketplace(sourceInput),
        isMarketplacesListEvent,
        MARKETPLACE_EVENT_TIMEOUT_MS,
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/marketplaces/remove": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const marketplaceId = typeof params.id === "string" ? params.id.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.skills.removeMarketplace(marketplaceId),
        isMarketplacesListEvent,
        MARKETPLACE_EVENT_TIMEOUT_MS,
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}
