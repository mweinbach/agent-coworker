import type { SessionEvent } from "../../protocol";

import { captureWorkspaceControlOutcome, sendSessionMutationError } from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createMemoryRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
  return {
    "cowork/memory/list": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const scope =
        params.scope === "user" ? "user" : params.scope === "workspace" ? "workspace" : undefined;
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.emitMemories(scope),
        (event): event is Extract<SessionEvent, { type: "memory_list" }> =>
          event.type === "memory_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/memory/upsert": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const scope = params.scope === "user" ? "user" : "workspace";
      const id = typeof params.id === "string" && params.id.trim() ? params.id.trim() : undefined;
      const content = typeof params.content === "string" ? params.content : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.upsertMemory(scope, id, content),
        (event): event is Extract<SessionEvent, { type: "memory_list" }> =>
          event.type === "memory_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/memory/delete": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const scope = params.scope === "user" ? "user" : "workspace";
      const id = typeof params.id === "string" ? params.id.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.deleteMemory(scope, id),
        (event): event is Extract<SessionEvent, { type: "memory_list" }> =>
          event.type === "memory_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}
