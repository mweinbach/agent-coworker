import type { SessionEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcBackupsRequestSchemas } from "../schema.backups";
import { captureWorkspaceControlOutcome, sendSessionMutationError } from "./outcomes";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createWorkspaceBackupRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/backups/workspace/read": async (ws, message) => {
      const parsed = jsonRpcBackupsRequestSchemas["cowork/backups/workspace/read"].safeParse(
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
      const params = parsed.data;
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.backups.listWorkspaceBackups(),
        (event): event is Extract<SessionEvent, { type: "workspace_backups" }> =>
          event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/delta/read": async (ws, message) => {
      const parsed = jsonRpcBackupsRequestSchemas["cowork/backups/workspace/delta/read"].safeParse(
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
      const params = parsed.data;
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) =>
          await runtime.backups.getWorkspaceDelta(params.targetSessionId, params.checkpointId),
        (event): event is Extract<SessionEvent, { type: "workspace_backup_delta" }> =>
          event.type === "workspace_backup_delta",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/checkpoint": async (ws, message) => {
      const parsed = jsonRpcBackupsRequestSchemas["cowork/backups/workspace/checkpoint"].safeParse(
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
      const params = parsed.data;
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => {
          await runtime.backups.createWorkspaceCheckpoint(params.targetSessionId);
        },
        (event): event is Extract<SessionEvent, { type: "workspace_backups" }> =>
          event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/restore": async (ws, message) => {
      const parsed = jsonRpcBackupsRequestSchemas["cowork/backups/workspace/restore"].safeParse(
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
      const params = parsed.data;
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => {
          await runtime.backups.restoreWorkspaceBackup(params.targetSessionId, params.checkpointId);
        },
        (event): event is Extract<SessionEvent, { type: "workspace_backups" }> =>
          event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/deleteCheckpoint": async (ws, message) => {
      const parsed = jsonRpcBackupsRequestSchemas[
        "cowork/backups/workspace/deleteCheckpoint"
      ].safeParse(message.params);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }
      const params = parsed.data;
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => {
          await runtime.backups.deleteWorkspaceCheckpoint(
            params.targetSessionId,
            params.checkpointId,
          );
        },
        (event): event is Extract<SessionEvent, { type: "workspace_backups" }> =>
          event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/deleteEntry": async (ws, message) => {
      const parsed = jsonRpcBackupsRequestSchemas["cowork/backups/workspace/deleteEntry"].safeParse(
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
      const params = parsed.data;
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => {
          await runtime.backups.deleteWorkspaceEntry(params.targetSessionId);
        },
        (event): event is Extract<SessionEvent, { type: "workspace_backups" }> =>
          event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}
