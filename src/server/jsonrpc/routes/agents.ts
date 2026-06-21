import { getSessionTaskLock } from "../../session/taskLocks";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcAgentRequestSchemas } from "../schema.agents";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

function assertAgentControlWritable(
  context: JsonRpcRouteContext,
  ws: Parameters<JsonRpcRouteContext["jsonrpc"]["send"]>[0],
  id: Parameters<JsonRpcRouteContext["jsonrpc"]["sendError"]>[1],
  threadId: string,
): boolean {
  const taskLock = getSessionTaskLock(
    {
      getTaskForThread: (sessionId) => context.tasks?.getForThread?.(sessionId),
      getActiveTaskForSourceSession: (sessionId) =>
        context.tasks?.getActiveForSourceSession?.(sessionId),
      getSessionRecord: (sessionId) => {
        const liveParentSessionId =
          context.threads.getLive(sessionId)?.runtime?.read.parentSessionId ?? null;
        if (liveParentSessionId) return { parentSessionId: liveParentSessionId };
        const persisted = context.threads.getPersisted(sessionId);
        return persisted ? { parentSessionId: persisted.parentSessionId } : null;
      },
    },
    threadId,
  );
  if (!taskLock) return true;
  context.jsonrpc.sendError(ws, id, {
    code: JSONRPC_ERROR_CODES.invalidRequest,
    message: taskLock.message,
    data: taskLock.data,
  });
  return false;
}

export function createAgentRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
  return {
    "cowork/session/agent/spawn": async (ws, message) => {
      const parsed = jsonRpcAgentRequestSchemas["cowork/session/agent/spawn"].safeParse(
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

      const {
        threadId,
        message: prompt,
        role,
        profileRef,
        model,
        reasoningEffort,
        nickname,
        taskType,
        targetPaths,
        contextMode,
        briefing,
        includeParentTodos,
        includeHarnessContext,
        forkContext,
      } = parsed.data;
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime || !prompt.trim()) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and message`,
        });
        return;
      }
      if (!assertAgentControlWritable(context, ws, message.id, threadId)) return;

      await runtime.agents.create({
        message: prompt,
        ...(role !== undefined ? { role } : {}),
        ...(profileRef !== undefined ? { profileRef } : {}),
        ...(nickname !== undefined ? { nickname } : {}),
        ...(taskType !== undefined ? { taskType } : {}),
        ...(targetPaths !== undefined ? { targetPaths } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(contextMode !== undefined ? { contextMode } : {}),
        ...(briefing !== undefined ? { briefing } : {}),
        ...(includeParentTodos !== undefined ? { includeParentTodos } : {}),
        ...(includeHarnessContext !== undefined ? { includeHarnessContext } : {}),
        ...(forkContext !== undefined ? { forkContext } : {}),
      });
      context.jsonrpc.sendResult(ws, message.id, {});
    },

    "cowork/session/agent/list": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId`,
        });
        return;
      }

      await runtime.agents.list();
      context.jsonrpc.sendResult(ws, message.id, {});
    },

    "cowork/session/agent/input/send": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      const prompt = typeof params.message === "string" ? params.message : "";
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime || !agentId || !prompt.trim()) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId, agentId, and message`,
        });
        return;
      }
      if (!assertAgentControlWritable(context, ws, message.id, threadId)) return;

      await runtime.agents.sendInput(
        agentId,
        prompt,
        typeof params.interrupt === "boolean" ? params.interrupt : undefined,
      );
      context.jsonrpc.sendResult(ws, message.id, {});
    },

    "cowork/session/agent/wait": async (ws, message) => {
      const parsed = jsonRpcAgentRequestSchemas["cowork/session/agent/wait"].safeParse(
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

      const { threadId, agentIds, timeoutMs, mode, includeFinalMessage, includeReport } =
        parsed.data;
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime || agentIds.length === 0) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and at least one agentId`,
        });
        return;
      }

      await runtime.agents.wait(agentIds, timeoutMs, mode, includeFinalMessage, includeReport);
      context.jsonrpc.sendResult(ws, message.id, {});
    },

    "cowork/session/agent/inspect": async (ws, message) => {
      const parsed = jsonRpcAgentRequestSchemas["cowork/session/agent/inspect"].safeParse(
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

      const { threadId, agentId } = parsed.data;
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId`,
        });
        return;
      }

      const event = await runtime.agents.inspect(agentId);
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/session/agent/resume": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime || !agentId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and agentId`,
        });
        return;
      }
      if (!assertAgentControlWritable(context, ws, message.id, threadId)) return;

      await runtime.agents.resume(agentId);
      context.jsonrpc.sendResult(ws, message.id, {});
    },

    "cowork/session/agent/close": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime || !agentId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and agentId`,
        });
        return;
      }

      await runtime.agents.close(agentId);
      context.jsonrpc.sendResult(ws, message.id, {});
    },
  };
}
