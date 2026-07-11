import { IdempotencyConflictError } from "../../../shared/idempotencyLedger";
import { resolveToolRetryIntent, type ToolRetryIntent } from "../../../shared/toolRetry";
import type { SessionEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcThreadTurnRequestSchemas } from "../schema.threadTurn";

import {
  captureBindingOutcome,
  type JsonRpcSessionError,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

type JsonRpcTurnStartOutcome =
  | Extract<SessionEvent, { type: "session_busy" }>
  | JsonRpcSessionError;
type JsonRpcTurnSteerOutcome =
  | Extract<SessionEvent, { type: "steer_accepted" }>
  | JsonRpcSessionError;

/**
 * Reject a turn before it reaches the session when the thread is pointed at a
 * local LM Studio server that is not running. The typed `data` payload lets
 * clients offer to start LM Studio and retry with the same clientMessageId;
 * because the rejection happens before `sendUserMessage`, the send is
 * retry-safe.
 */
async function rejectIfLmStudioUnreachable(
  context: JsonRpcRouteContext,
  ws: Parameters<JsonRpcRouteContext["jsonrpc"]["sendError"]>[0],
  id: Parameters<JsonRpcRouteContext["jsonrpc"]["sendError"]>[1],
  runtime: { read?: { publicConfig?: { provider?: string }; configEvent?: { config?: unknown } } },
): Promise<boolean> {
  const service = context.lmstudioLocal;
  if (!service) return false;
  if (runtime.read?.publicConfig?.provider !== "lmstudio") return false;
  const config = runtime.read?.configEvent?.config as { providerOptions?: unknown } | undefined;
  const status = await service.getStatus({ providerOptions: config?.providerOptions });
  if (status.running) return false;
  context.jsonrpc.sendError(ws, id, {
    code: JSONRPC_ERROR_CODES.invalidRequest,
    message: `LM Studio isn't running at ${status.baseUrl}. Start LM Studio's local server and try again.`,
    data: {
      reason: "lmstudio_unreachable",
      provider: "lmstudio",
      baseUrl: status.baseUrl,
      installed: status.installed,
      canAutoStart: status.canAutoStart,
    },
  });
  return true;
}

export function createTurnRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
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

      const { threadId, input, clientMessageId, references, retry } = parsed.data;
      const { text, attachments, orderedParts } = context.utils.extractInput(input);
      const hasInput = text || attachments.length > 0;
      if (!threadId || !hasInput) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "turn/start requires threadId and non-empty input",
        });
        return;
      }
      await context.runtime.waitForStartupReady();
      const binding = context.threads.subscribe(ws, threadId);
      if (!binding?.runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      if (await rejectIfLmStudioUnreachable(context, ws, message.id, binding.runtime)) {
        return;
      }
      const runtime = binding.runtime;
      if (retry && ws.data.rpc?.capabilities.toolRetryLineage !== true) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: "turn/start retry requires the toolRetryLineage client capability.",
        });
        return;
      }
      let idempotencyClaim: ReturnType<typeof runtime.turns.claimUserMessage>;
      try {
        idempotencyClaim = runtime.turns.claimUserMessage({
          text,
          clientMessageId,
          attachments: attachments.length > 0 ? attachments : undefined,
          inputParts: orderedParts,
          references,
          retry,
        });
      } catch (error) {
        if (!(error instanceof IdempotencyConflictError)) throw error;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: `turn/start clientMessageId conflict: ${error.message}`,
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
          turn: {
            id: replay.value.turnId,
            threadId,
            status: "inProgress",
            items: [],
          },
          replayed: true,
        });
        return;
      }
      let toolRetryIntent: ToolRetryIntent | undefined;
      try {
        toolRetryIntent = retry
          ? resolveToolRetryIntent(runtime.snapshot.peek().feed, retry)
          : undefined;
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Invalid tool retry target.";
        runtime.turns.rejectUserMessageClaim(idempotencyClaim, detail);
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail,
        });
        return;
      }
      const outcome = await captureBindingOutcome(
        context,
        binding,
        () => {
          return runtime.turns.sendUserMessage(
            text,
            clientMessageId,
            undefined,
            attachments.length > 0 ? attachments : undefined,
            orderedParts,
            references,
            {
              allowThreadManagementTools: ws.data?.taskReadAllowed !== false,
              idempotencyClaim,
              ...(toolRetryIntent ? { toolRetryIntent } : {}),
            },
          );
        },
        (event): event is JsonRpcTurnStartOutcome =>
          (event.type === "session_busy" &&
            event.sessionId === binding.runtime?.id &&
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

      const { threadId, turnId, input, clientMessageId, references } = parsed.data;
      const { text, attachments, orderedParts } = context.utils.extractInput(input);
      const runtime = context.threads.getLive(threadId)?.runtime;
      const expectedTurnId = turnId || (runtime?.turns.activeTurnId ?? "");
      const hasSteerInput = text || attachments.length > 0;
      if (!runtime || !hasSteerInput || !expectedTurnId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "turn/steer requires threadId, active turnId, and non-empty input",
        });
        return;
      }
      await context.runtime.waitForStartupReady();
      const binding = context.threads.getLive(threadId);
      if (!binding) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const steerRequestId = crypto.randomUUID();
      const outcome = await context.events.capture(
        binding,
        () =>
          runtime.turns.sendSteerMessage(
            text,
            expectedTurnId,
            clientMessageId,
            attachments.length > 0 ? attachments : undefined,
            orderedParts,
            references,
            steerRequestId,
          ),
        (event): event is JsonRpcTurnSteerOutcome => {
          if (event.sessionId !== runtime.id) return false;
          if (event.type === "steer_accepted") {
            return event.turnId === expectedTurnId && event.steerRequestId === steerRequestId;
          }
          return context.utils.isSessionError(event) && event.steerRequestId === steerRequestId;
        },
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
      const runtime = context.threads.getLive(threadId)?.runtime;
      if (!runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      runtime.turns.cancel();
      context.jsonrpc.sendResult(ws, message.id, {});
    },
  };
}
