import { IdempotencyConflictError } from "../../../shared/idempotencyLedger";
import type { SessionEvent } from "../../protocol";
import type { UserMessageAdmission } from "../../session/TurnExecutionManager";
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
      const event = await captureBindingOutcome(
        context,
        binding,
        () => binding.runtime?.skills.listCommands(),
        (candidate): candidate is Extract<SessionEvent, { type: "commands" }> =>
          candidate.type === "commands" && candidate.sessionId === binding.runtime?.id,
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
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
      const argumentsText = parsed.data.arguments ?? "";
      await context.runtime.waitForStartupReady();
      const binding = context.threads.subscribe(ws, threadId);
      if (!binding?.runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const runtime = binding.runtime;
      const trimmedName = name.trim();
      const trimmedArgs = argumentsText.trim();
      const slashText = `/${trimmedName}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
      let idempotencyClaim: ReturnType<typeof runtime.turns.claimUserMessage> = null;
      if (typeof runtime.turns?.claimUserMessage === "function") {
        try {
          idempotencyClaim = runtime.turns.claimUserMessage({
            text: argumentsText,
            displayText: slashText,
            clientMessageId,
          });
        } catch (error) {
          if (!(error instanceof IdempotencyConflictError)) throw error;
          context.jsonrpc.sendError(ws, message.id, {
            code: JSONRPC_ERROR_CODES.invalidRequest,
            message: `command/execute clientMessageId conflict: ${error.message}`,
          });
          return;
        }
        if (idempotencyClaim?.kind === "replay") {
          const replay = await idempotencyClaim.outcome;
          if (replay.status === "rejected") {
            context.jsonrpc.sendError(ws, message.id, {
              code: JSONRPC_ERROR_CODES.invalidRequest,
              message: replay.message,
            });
            return;
          }
          context.jsonrpc.sendResult(ws, message.id, {
            turn: { id: replay.value.turnId, threadId, status: "inProgress", items: [] },
            replayed: true,
          });
          return;
        }
      }
      const allowThreadManagementTools = ws.data?.taskReadAllowed !== false;
      if (idempotencyClaim) {
        const outcome = await new Promise<UserMessageAdmission>((resolve, reject) => {
          void runtime.skills
            .executeCommand(name, argumentsText, clientMessageId, {
              allowThreadManagementTools,
              idempotencyClaim,
              onAdmission: resolve,
            })
            .then(
              () => reject(new Error("Command execution finished without an admission outcome.")),
              reject,
            );
        }).catch((error: unknown) => {
          runtime.turns.rejectUserMessageClaim(
            idempotencyClaim,
            error instanceof Error
              ? error.message
              : "The original command execution request was not accepted.",
          );
          throw error;
        });
        if (outcome.status === "rejected") {
          runtime.turns.rejectUserMessageClaim(idempotencyClaim, outcome.error.message);
          sendSessionMutationError(context, ws, message.id, outcome.error);
          return;
        }
        context.jsonrpc.sendResult(ws, message.id, {
          turn: { id: outcome.turnId, threadId, status: "inProgress", items: [] },
        });
        return;
      }
      const outcome = await captureBindingOutcome(
        context,
        binding,
        () =>
          runtime.skills.executeCommand(name, parsed.data.arguments, clientMessageId, {
            allowThreadManagementTools,
          }),
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
