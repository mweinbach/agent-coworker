import type { AgentConfig } from "../../../types";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { createThreadTurnProjector } from "../threadReadProjector";

import { compactSnapshotFeedForThreadRead, toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

const THREAD_READ_JOURNAL_BATCH_SIZE = 250;

export function createThreadRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "thread/start": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
        : undefined;
      const model = typeof params.model === "string" ? params.model : undefined;
      const cwd = typeof params.cwd === "string" && params.cwd.trim()
        ? params.cwd.trim()
        : context.getConfig().workingDirectory;
      const session = context.threads.create({ cwd, provider, model });
      context.threads.subscribe(ws, session.id);
      const thread = context.utils.buildThreadFromSession(session);
      void context.journal.enqueue({
        threadId: session.id,
        ts: new Date().toISOString(),
        eventType: "thread/started",
        turnId: null,
        itemId: null,
        requestId: null,
        payload: { thread },
      }).catch(() => {
        // Best-effort journal persistence.
      });
      context.jsonrpc.sendResult(ws, message.id, { thread });
      context.jsonrpc.send(ws, { method: "thread/started", params: { thread } });
    },

    "thread/resume": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const afterSeq = typeof params.afterSeq === "number" && Number.isFinite(params.afterSeq)
        ? Math.max(0, Math.floor(params.afterSeq))
        : 0;
      if (!threadId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "thread/resume requires threadId",
        });
        return;
      }
      const binding = context.threads.load(threadId);
      if (!binding?.session) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const thread = context.utils.buildThreadFromSession(binding.session);
      let replayedRequestIds: ReadonlySet<string> | undefined;
      if (afterSeq > 0) {
        await context.journal.waitForIdle(threadId);
        binding.session.beginDisconnectedReplayBuffer();
        replayedRequestIds = context.journal.replay(ws, threadId, afterSeq);
      }
      const pendingPromptEvents = binding.session.getPendingPromptEventsForReplay();
      context.threads.subscribe(
        ws,
        threadId,
        {
          ...(binding.session.activeTurnId
            ? {
                initialActiveTurnId: binding.session.activeTurnId,
                initialAgentText: binding.session.getLatestAssistantText() ?? "",
              }
            : {}),
          ...(afterSeq > 0 ? { drainDisconnectedReplayBuffer: true } : {}),
          pendingPromptEvents,
          ...(replayedRequestIds?.size ? { skipPendingPromptRequestIds: replayedRequestIds } : {}),
        },
      );
      context.jsonrpc.sendResult(ws, message.id, { thread });
      context.jsonrpc.send(ws, { method: "thread/started", params: { thread } });
    },

    "thread/list": (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined;
      const threads = new Map<string, ReturnType<JsonRpcRouteContext["utils"]["buildThreadFromRecord"]>>();
      for (const record of context.threads.listPersisted({ ...(cwd ? { cwd } : {}) })) {
        if (!context.utils.shouldIncludeThreadSummary({
          titleSource: record.titleSource,
          messageCount: record.messageCount,
          hasPendingAsk: record.hasPendingAsk,
          hasPendingApproval: record.hasPendingApproval,
          executionState: record.executionState ?? null,
        })) {
          continue;
        }
        threads.set(record.sessionId, context.utils.buildThreadFromRecord(record));
      }
      for (const session of context.threads.listLiveRoot({ ...(cwd ? { cwd } : {}) })) {
        threads.set(session.id, context.utils.buildThreadFromSession(session));
      }
      context.jsonrpc.sendResult(ws, message.id, {
        threads: [...threads.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      });
    },

    "thread/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      if (!threadId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "thread/read requires threadId",
        });
        return;
      }
      const snapshot = context.threads.readSnapshot(threadId);
      if (!snapshot) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      const binding = context.threads.getLive(threadId);
      const thread = binding?.session
        ? context.utils.buildThreadFromSession(binding.session)
        : context.utils.buildThreadFromRecord(context.threads.getPersisted(threadId)!);
      await context.journal.waitForIdle(threadId);
      let journalTailSeq = 0;
      let turns: ReturnType<ReturnType<typeof createThreadTurnProjector>["build"]> | undefined;
      if (params.includeTurns === true) {
        const projector = createThreadTurnProjector();
        let afterSeq = 0;
        while (true) {
          const batch = context.journal.list(threadId, {
            afterSeq,
            limit: THREAD_READ_JOURNAL_BATCH_SIZE,
          });
          if (batch.length === 0) {
            break;
          }
          for (const event of batch) {
            projector.handle(event);
          }
          journalTailSeq = batch.at(-1)?.seq ?? journalTailSeq;
          if (batch.length < THREAD_READ_JOURNAL_BATCH_SIZE) {
            break;
          }
          afterSeq = journalTailSeq;
        }
        turns = projector.build();
      }
      context.jsonrpc.sendResult(ws, message.id, {
        thread: {
          ...thread,
          ...(turns ? { turns } : {}),
        },
        coworkSnapshot: compactSnapshotFeedForThreadRead(snapshot),
        ...(params.includeTurns === true
          ? { journalTailSeq }
          : {}),
      });
    },

    "thread/unsubscribe": (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      if (!threadId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "thread/unsubscribe requires threadId",
        });
        return;
      }
      const status = context.threads.unsubscribe(ws, threadId);
      context.jsonrpc.sendResult(ws, message.id, { status });
      if (status === "unsubscribed") {
        context.jsonrpc.send(ws, {
          method: "thread/closed",
          params: { threadId },
        });
      }
    },
  };
}
