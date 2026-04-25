import type { SessionEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { formatA2uiActionDeliveryText, jsonRpcA2uiRequestSchemas } from "../schema.a2ui";

import {
  captureBindingOutcome,
  type JsonRpcSessionError,
  sendSessionMutationError,
} from "./outcomes";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

type JsonRpcTurnStartOutcome =
  | Extract<SessionEvent, { type: "session_busy" }>
  | JsonRpcSessionError;
type JsonRpcTurnSteerOutcome =
  | Extract<SessionEvent, { type: "steer_accepted" }>
  | JsonRpcSessionError;

export function createA2uiRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
  return {
    "cowork/session/a2ui/action": async (ws, message) => {
      const parsed = jsonRpcA2uiRequestSchemas["cowork/session/a2ui/action"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }

      const { threadId, surfaceId, componentId, eventType, payload, clientMessageId } = parsed.data;

      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!binding || !runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }

      if (!runtime.a2ui.enabled) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method}: A2UI is disabled for this workspace`,
        });
        return;
      }

      const validation = runtime.a2ui.validateAction({ surfaceId, componentId });
      if (!validation.ok) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method}: ${validation.error}`,
        });
        return;
      }

      const text = formatA2uiActionDeliveryText({
        surfaceId,
        componentId,
        eventType,
        ...(payload ? { payload } : {}),
      });

      // If a turn is currently running, deliver the action as a steer.
      // Otherwise, start a new turn carrying the action as the user message.
      const activeTurnId = runtime.turns.activeTurnId;
      if (activeTurnId) {
        const outcome = await captureBindingOutcome(
          context,
          binding,
          () => runtime.turns.sendSteerMessage(text, activeTurnId, clientMessageId),
          (event): event is JsonRpcTurnSteerOutcome =>
            (event.type === "steer_accepted" &&
              event.sessionId === runtime.id &&
              event.turnId === activeTurnId) ||
            context.utils.isSessionError(event),
        );
        if (outcome.type === "error") {
          sendSessionMutationError(context, ws, message.id, outcome);
          return;
        }
        context.jsonrpc.sendResult(ws, message.id, {
          delivery: "delivered-as-steer",
          turnId: outcome.turnId,
        });
        return;
      }

      const outcome = await captureBindingOutcome(
        context,
        binding,
        () => runtime.turns.sendUserMessage(text, clientMessageId),
        (event): event is JsonRpcTurnStartOutcome =>
          (event.type === "session_busy" &&
            event.sessionId === runtime.id &&
            event.busy === true &&
            typeof event.turnId === "string" &&
            event.turnId.trim().length > 0) ||
          context.utils.isSessionError(event),
      );
      if (outcome.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, {
        delivery: "delivered-as-turn",
        turnId: outcome.turnId,
      });
    },
  };
}
