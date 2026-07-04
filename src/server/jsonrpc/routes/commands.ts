import type { SessionEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcCommandRequestSchemas } from "../schema.commands";

import {
  captureBindingOutcome,
  type JsonRpcSessionError,
  sendSessionMutationError,
} from "./outcomes";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

type CommandExecutionOutcome =
  | Extract<SessionEvent, { type: "session_busy" }>
  | JsonRpcSessionError;

export function createCommandRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
  return {
    "command/list": async (ws, message) => {
      const parsed = jsonRpcCommandRequestSchemas["command/list"].safeParse(message.params);
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid command/list params",
        });
        return;
      }
      const binding = context.threads.subscribe(ws, parsed.data.threadId);
      if (!binding?.runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${parsed.data.threadId}`,
        });
        return;
      }
      const event = await context.events.capture(
        binding,
        () => binding.runtime?.skills.listCommands(),
        (candidate): candidate is Extract<SessionEvent, { type: "commands" }> =>
          candidate.type === "commands" && candidate.sessionId === binding.runtime?.id,
      );
      context.jsonrpc.sendResult(ws, message.id, { commands: event.commands });
    },

    "command/execute": async (ws, message) => {
      const parsed = jsonRpcCommandRequestSchemas["command/execute"].safeParse(message.params);
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid command/execute params",
        });
        return;
      }
      const { threadId, name, clientMessageId } = parsed.data;
      await context.runtime.waitForStartupReady();
      const binding = context.threads.subscribe(ws, threadId);
      if (!binding?.runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const outcome = await captureBindingOutcome(
        context,
        binding,
        () => binding.runtime?.skills.executeCommand(name, parsed.data.arguments, clientMessageId),
        (event): event is CommandExecutionOutcome =>
          (event.type === "session_busy" &&
            event.sessionId === threadId &&
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
        turn: { id: outcome.turnId, threadId, status: "inProgress", items: [] },
      });
    },
  };
}
