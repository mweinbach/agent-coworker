import type { ServerEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcThreadTurnRequestSchemas } from "../schema.threadTurn";

import { captureBindingOutcome, type JsonRpcSessionError, sendSessionMutationError } from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

type JsonRpcTurnStartOutcome =
  | Extract<ServerEvent, { type: "session_busy" }>
  | JsonRpcSessionError;
type JsonRpcTurnSteerOutcome =
  | Extract<ServerEvent, { type: "steer_accepted" }>
  | JsonRpcSessionError;

export function createTurnRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "turn/start": async (ws, message) => {
      const parsed = jsonRpcThreadTurnRequestSchemas["turn/start"].safeParse(message.params);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }

      const { threadId, input, clientMessageId } = parsed.data;
      const { text, attachments, orderedParts } = context.utils.extractInput(input);
      const hasInput = text || attachments.length > 0;
      if (!threadId || !hasInput) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "turn/start requires threadId and non-empty input",
        });
        return;
      }
      const binding = context.threads.subscribe(ws, threadId);
      if (!binding?.session) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const outcome = await captureBindingOutcome(
        context,
        binding,
        () =>
          binding.session!.sendUserMessage(
            text,
            clientMessageId,
            undefined,
            attachments.length > 0 ? attachments : undefined,
            orderedParts,
          ),
        (event): event is JsonRpcTurnStartOutcome => (
          (event.type === "session_busy"
            && event.sessionId === binding.session!.id
            && event.busy === true
            && typeof event.turnId === "string"
            && event.turnId.trim().length > 0)
          || context.utils.isSessionError(event)
        ),
      );
      if (outcome.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, {
        turn: {
          id: outcome.turnId,
          threadId,
          status: "inProgress",
          items: [],
        },
      });
    },

    "turn/steer": async (ws, message) => {
      const parsed = jsonRpcThreadTurnRequestSchemas["turn/steer"].safeParse(message.params);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }

      const { threadId, turnId, input, clientMessageId } = parsed.data;
      const { text, attachments, orderedParts } = context.utils.extractInput(input);
      const expectedTurnId = turnId || (context.threads.getLive(threadId)?.session?.activeTurnId ?? "");
      const session = context.threads.getLive(threadId)?.session;
      const hasSteerInput = text || attachments.length > 0;
      if (!session || !hasSteerInput || !expectedTurnId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "turn/steer requires threadId, active turnId, and non-empty input",
        });
        return;
      }
      const binding = context.threads.getLive(threadId);
      if (!binding) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const outcome = await captureBindingOutcome(
        context,
        binding,
        () =>
          session.sendSteerMessage(
            text,
            expectedTurnId,
            clientMessageId,
            attachments.length > 0 ? attachments : undefined,
            orderedParts,
          ),
        (event): event is JsonRpcTurnSteerOutcome => (
          (event.type === "steer_accepted"
            && event.sessionId === session.id
            && event.turnId === expectedTurnId)
          || context.utils.isSessionError(event)
        ),
      );
      if (outcome.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, {
        turnId: outcome.turnId,
      });
    },

    "turn/interrupt": (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const session = context.threads.getLive(threadId)?.session;
      if (!session) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      session.cancel();
      context.jsonrpc.sendResult(ws, message.id, {});
    },
  };
}
