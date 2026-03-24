import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcAgentRequestSchemas } from "../schema.agents";

import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createAgentRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/session/agent/spawn": async (ws, message) => {
      const parsed = jsonRpcAgentRequestSchemas["cowork/session/agent/spawn"].safeParse(message.params);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }

      const { threadId, message: prompt, role, model, reasoningEffort, forkContext } = parsed.data;
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session || !prompt.trim()) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and message`,
        });
        return;
      }

      await session.createAgentSession({
        message: prompt,
        ...(role !== undefined ? { role } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(forkContext !== undefined ? { forkContext } : {}),
      });
      context.jsonrpc.sendResult(ws, message.id, {});
    },

    "cowork/session/agent/list": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId`,
        });
        return;
      }

      await session.listAgentSessions();
      context.jsonrpc.sendResult(ws, message.id, {});
    },

    "cowork/session/agent/input/send": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      const prompt = typeof params.message === "string" ? params.message : "";
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session || !agentId || !prompt.trim()) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId, agentId, and message`,
        });
        return;
      }

      await session.sendAgentInput(agentId, prompt, typeof params.interrupt === "boolean" ? params.interrupt : undefined);
      context.jsonrpc.sendResult(ws, message.id, {});
    },

    "cowork/session/agent/wait": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const agentIds = Array.isArray(params.agentIds)
        ? params.agentIds.filter((agentId): agentId is string => typeof agentId === "string" && agentId.trim().length > 0)
        : [];
      const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
        ? Math.max(0, Math.floor(params.timeoutMs))
        : undefined;
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session || agentIds.length === 0) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and at least one agentId`,
        });
        return;
      }

      await session.waitForAgents(agentIds, timeoutMs);
      context.jsonrpc.sendResult(ws, message.id, {});
    },

    "cowork/session/agent/resume": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session || !agentId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and agentId`,
        });
        return;
      }

      await session.resumeAgent(agentId);
      context.jsonrpc.sendResult(ws, message.id, {});
    },

    "cowork/session/agent/close": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session || !agentId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and agentId`,
        });
        return;
      }

      await session.closeAgent(agentId);
      context.jsonrpc.sendResult(ws, message.id, {});
    },
  };
}
