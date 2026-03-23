import type { ServerEvent } from "../../protocol";

import {
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createWorkspaceBackupRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/backups/workspace/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.listWorkspaceBackups(),
        (event): event is Extract<ServerEvent, { type: "workspace_backups" }> => event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/delta/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const targetSessionId = typeof params.targetSessionId === "string" ? params.targetSessionId.trim() : "";
      const checkpointId = typeof params.checkpointId === "string" ? params.checkpointId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.getWorkspaceBackupDelta(targetSessionId, checkpointId),
        (event): event is Extract<ServerEvent, { type: "workspace_backup_delta" }> => event.type === "workspace_backup_delta",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/checkpoint": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const targetSessionId = typeof params.targetSessionId === "string" ? params.targetSessionId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          await session.createWorkspaceBackupCheckpoint(targetSessionId);
        },
        (event): event is Extract<ServerEvent, { type: "workspace_backups" }> => event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/restore": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const targetSessionId = typeof params.targetSessionId === "string" ? params.targetSessionId.trim() : "";
      const checkpointId = typeof params.checkpointId === "string" && params.checkpointId.trim()
        ? params.checkpointId.trim()
        : undefined;
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          await session.restoreWorkspaceBackup(targetSessionId, checkpointId);
        },
        (event): event is Extract<ServerEvent, { type: "workspace_backups" }> => event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/deleteCheckpoint": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const targetSessionId = typeof params.targetSessionId === "string" ? params.targetSessionId.trim() : "";
      const checkpointId = typeof params.checkpointId === "string" && params.checkpointId.trim()
        ? params.checkpointId.trim()
        : undefined;
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          if (checkpointId) {
            await session.deleteWorkspaceBackupCheckpoint(targetSessionId, checkpointId);
          }
        },
        (event): event is Extract<ServerEvent, { type: "workspace_backups" }> => event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/backups/workspace/deleteEntry": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const targetSessionId = typeof params.targetSessionId === "string" ? params.targetSessionId.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => {
          await session.deleteWorkspaceBackupEntry(targetSessionId);
        },
        (event): event is Extract<ServerEvent, { type: "workspace_backups" }> => event.type === "workspace_backups",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}
