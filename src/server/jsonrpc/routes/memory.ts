import { sameWorkspacePath } from "../../../utils/workspacePath";
import type { SessionEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";

import {
  captureBindingOutcome,
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
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
        async (runtime) => await runtime.memory.list(scope),
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
        async (runtime) => await runtime.memory.upsert(scope, id, content),
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
        async (runtime) => await runtime.memory.delete(scope, id),
        (event): event is Extract<SessionEvent, { type: "memory_list" }> =>
          event.type === "memory_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/memory/advanced/list": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const folder = typeof params.folder === "string" ? params.folder : undefined;
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.memory.listAdvanced(folder),
        (event): event is Extract<SessionEvent, { type: "advanced_memory_list" }> =>
          event.type === "advanced_memory_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/memory/advanced/upsert": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const folder = typeof params.folder === "string" ? params.folder : undefined;
      const slug =
        typeof params.slug === "string" && params.slug.trim() ? params.slug.trim() : undefined;
      const name = typeof params.name === "string" ? params.name : "";
      const description = typeof params.description === "string" ? params.description : "";
      const type = typeof params.type === "string" ? params.type : undefined;
      const body = typeof params.body === "string" ? params.body : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) =>
          await runtime.memory.upsertAdvanced(folder, { slug, name, description, type, body }),
        (event): event is Extract<SessionEvent, { type: "advanced_memory_list" }> =>
          event.type === "advanced_memory_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/memory/advanced/delete": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const folder = typeof params.folder === "string" ? params.folder : undefined;
      const slug = typeof params.slug === "string" ? params.slug.trim() : "";
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.memory.deleteAdvanced(folder, slug),
        (event): event is Extract<SessionEvent, { type: "advanced_memory_list" }> =>
          event.type === "advanced_memory_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/memory/advanced/generate": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const folder = typeof params.folder === "string" ? params.folder : undefined;
      if (!threadId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method}: threadId is required`,
        });
        return;
      }

      await context.journal.waitForIdle(threadId);
      const binding = context.threads.load(threadId);
      if (!binding?.runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const runtime = binding.runtime;
      if (!sameWorkspacePath(runtime.read.workingDirectory, cwd)) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method}: thread does not belong to the requested workspace`,
        });
        return;
      }

      const event = await captureBindingOutcome(
        context,
        binding,
        async () => await runtime.memory.generateAdvancedFromHistory(folder),
        (event): event is Extract<SessionEvent, { type: "advanced_memory_list" }> =>
          event.type === "advanced_memory_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}
