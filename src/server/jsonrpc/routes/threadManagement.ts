import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcThreadManagementRequestSchemas } from "../schema.threadManagement";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext, JsonRpcThread } from "./types";

function toJsonRpcThread(summary: import("../../threads/types").ThreadSummary): JsonRpcThread {
  return {
    id: summary.threadId,
    title: summary.title,
    preview: summary.preview,
    modelProvider: summary.modelProvider,
    model: summary.model,
    cwd: summary.cwd,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messageCount: summary.messageCount,
    lastEventSeq: summary.lastEventSeq,
    status: { type: summary.status },
    pinned: summary.pinned,
    pinnedAt: summary.pinnedAt ?? null,
    archived: summary.archived,
    archivedAt: summary.archivedAt ?? null,
  };
}

function sendInvalidParams(
  context: JsonRpcRouteContext,
  ws: Parameters<JsonRpcRouteContext["jsonrpc"]["sendError"]>[0],
  id: Parameters<JsonRpcRouteContext["jsonrpc"]["sendError"]>[1],
  method: string,
  detail?: string,
): void {
  context.jsonrpc.sendError(ws, id, {
    code: JSONRPC_ERROR_CODES.invalidParams,
    message: detail ? `${method}: ${detail}` : `${method}: invalid params`,
  });
}

export function createThreadManagementRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "thread/pinned/set": async (ws, message) => {
      const parsed = jsonRpcThreadManagementRequestSchemas["thread/pinned/set"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        sendInvalidParams(context, ws, message.id, message.method, parsed.error.issues[0]?.message);
        return;
      }
      if (!context.threadManagement) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.internalError,
          message: "Thread management is unavailable",
        });
        return;
      }
      try {
        const thread = await context.threadManagement.setPinned(parsed.data);
        context.jsonrpc.sendResult(ws, message.id, { thread: toJsonRpcThread(thread) });
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "thread/archived/set": async (ws, message) => {
      const parsed = jsonRpcThreadManagementRequestSchemas["thread/archived/set"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        sendInvalidParams(context, ws, message.id, message.method, parsed.error.issues[0]?.message);
        return;
      }
      if (!context.threadManagement) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.internalError,
          message: "Thread management is unavailable",
        });
        return;
      }
      try {
        const thread = await context.threadManagement.setArchived(parsed.data);
        context.jsonrpc.sendResult(ws, message.id, { thread: toJsonRpcThread(thread) });
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
