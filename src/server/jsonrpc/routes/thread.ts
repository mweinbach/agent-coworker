import type { AgentConfig } from "../../../types";
import {
  enrichSessionSnapshotCitationsFromCache,
  primeSessionSnapshotCitationCache,
} from "../../citationMetadata";
import { JSONRPC_ERROR_CODES, type JsonRpcLiteRequest } from "../protocol";
import { jsonRpcThreadTurnRequestSchemas } from "../schema.threadTurn";
import { createThreadTurnProjector } from "../threadReadProjector";
import { listWorkspaceSummaries } from "../workspaceCatalog";
import { listWorkspaceChatThreads } from "./shared";

import type { JsonRpcRequestHandler, JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

const THREAD_READ_JOURNAL_BATCH_SIZE = 250;

type ReplayHealth = {
  trusted: boolean;
  snapshotRequired: boolean;
  reason: "ok" | "journal_write_failed" | "after_seq_beyond_tail";
  tailSeq: number;
  failedWriteCount: number;
  droppedEventCount: number;
};

function buildReplayHealth(
  context: JsonRpcRouteContext,
  threadId: string,
  afterSeq = 0,
): ReplayHealth | undefined {
  const health = context.journal.getHealth?.(threadId);
  if (!health) return undefined;
  const reason = !health.trusted
    ? "journal_write_failed"
    : afterSeq > health.tailSeq
      ? "after_seq_beyond_tail"
      : "ok";
  return {
    trusted: reason === "ok",
    snapshotRequired: reason !== "ok",
    reason,
    tailSeq: health.tailSeq,
    failedWriteCount: health.failedWriteCount,
    droppedEventCount: health.droppedEventCount,
  };
}

function buildThreadCreationKey(cwd: string, clientThreadId: string): string {
  return `${cwd}\0${clientThreadId}`;
}

async function resolveThreadListWorkspacePath(
  context: JsonRpcRouteContext,
  params: Record<string, unknown>,
  method: string,
): Promise<string> {
  try {
    return context.utils.resolveWorkspacePath(params, method);
  } catch (error) {
    const requestedCwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
    if (method !== "thread/list" || !requestedCwd || !context.desktopService) {
      throw error;
    }

    const { workspaces } = await listWorkspaceSummaries({
      workingDirectory: context.getConfig().workingDirectory,
      desktopService: context.desktopService,
      homedir: context.homedir,
    });
    const workspace = workspaces.find((entry) => entry.path === requestedCwd);
    if (!workspace) {
      throw error;
    }
    return workspace.path;
  }
}

function sendInvalidParams(
  context: JsonRpcRouteContext,
  ws: Parameters<JsonRpcRouteContext["jsonrpc"]["sendError"]>[0],
  message: JsonRpcLiteRequest,
  detail?: string,
) {
  context.jsonrpc.sendError(ws, message.id, {
    code: JSONRPC_ERROR_CODES.invalidParams,
    message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
  });
}

function readThreadState(context: JsonRpcRouteContext, threadId: string) {
  const snapshot = context.threads.readSnapshot(threadId);
  if (!snapshot) return null;

  const runtime = context.threads.getLive(threadId)?.runtime;
  if (runtime) {
    return { snapshot, thread: context.utils.buildThreadFromSession(runtime) };
  }

  const persistedThread = context.threads.getPersisted(threadId);
  if (!persistedThread) return null;
  return { snapshot, thread: context.utils.buildThreadFromRecord(persistedThread) };
}

export function createThreadRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
  const sendThreadReadResult = async (
    ws: Parameters<JsonRpcRequestHandler>[0],
    message: JsonRpcLiteRequest,
    {
      threadId,
      afterSeq = 0,
      includeTurns = false,
    }: {
      threadId: string;
      afterSeq?: number;
      includeTurns?: boolean;
    },
  ) => {
    let state = readThreadState(context, threadId);
    if (!state) {
      context.jsonrpc.sendError(ws, message.id, {
        code: JSONRPC_ERROR_CODES.invalidParams,
        message: `Unknown thread: ${threadId}`,
      });
      return;
    }
    await context.journal.waitForIdle(threadId);
    state = readThreadState(context, threadId);
    if (!state) {
      context.jsonrpc.sendError(ws, message.id, {
        code: JSONRPC_ERROR_CODES.invalidParams,
        message: `Unknown thread: ${threadId}`,
      });
      return;
    }
    const enrichedSnapshot = enrichSessionSnapshotCitationsFromCache(state.snapshot);
    let journalTailSeq = afterSeq;
    let turns: ReturnType<ReturnType<typeof createThreadTurnProjector>["build"]> | undefined;
    if (includeTurns) {
      const projector = createThreadTurnProjector();
      while (true) {
        const batch = context.journal.list(threadId, {
          afterSeq: journalTailSeq,
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
      }
      turns = projector.build();
    }
    const replayHealth = buildReplayHealth(context, threadId, journalTailSeq);
    context.jsonrpc.sendResult(ws, message.id, {
      thread: {
        ...state.thread,
        ...(turns ? { turns } : {}),
      },
      coworkSnapshot: enrichedSnapshot,
      ...(includeTurns ? { journalTailSeq } : {}),
      ...(replayHealth ? { replayHealth } : {}),
    });
    queueMicrotask(() => {
      primeSessionSnapshotCitationCache(enrichedSnapshot);
    });
  };

  return {
    "thread/start": async (ws, message) => {
      const parsed = jsonRpcThreadTurnRequestSchemas["thread/start"].safeParse(
        message.params ?? {},
      );
      if (!parsed.success) {
        sendInvalidParams(context, ws, message, parsed.error.issues[0]?.message);
        return;
      }
      const provider = parsed.data.provider as AgentConfig["provider"] | undefined;
      const model = parsed.data.model;
      const clientThreadId = parsed.data.clientThreadId;
      let cwd: string;
      try {
        cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : `${message.method} requires cwd`,
        });
        return;
      }
      const creationKey = clientThreadId ? buildThreadCreationKey(cwd, clientThreadId) : null;
      const existingRuntime = creationKey ? context.threads.getByCreationKey?.(creationKey) : null;
      if (existingRuntime) {
        context.threads.subscribe(ws, existingRuntime.id);
        const thread = context.utils.buildThreadFromSession(existingRuntime);
        context.jsonrpc.sendResult(ws, message.id, { thread });
        context.jsonrpc.send(ws, { method: "thread/started", params: { thread } });
        return;
      }
      const runtime = context.threads.create({ cwd, provider, model });
      if (creationKey) {
        await context.threads.rememberCreationKey?.(creationKey, runtime.id);
      }
      context.threads.subscribe(ws, runtime.id);
      const thread = context.utils.buildThreadFromSession(runtime);
      void context.journal
        .enqueue({
          threadId: runtime.id,
          ts: new Date().toISOString(),
          eventType: "thread/started",
          turnId: null,
          itemId: null,
          requestId: null,
          payload: { thread },
        })
        .catch(() => {
          // Best-effort journal persistence.
        });
      context.jsonrpc.sendResult(ws, message.id, { thread });
      context.jsonrpc.send(ws, { method: "thread/started", params: { thread } });
    },

    "thread/resume": async (ws, message) => {
      const parsed = jsonRpcThreadTurnRequestSchemas["thread/resume"].safeParse(message.params);
      if (!parsed.success) {
        sendInvalidParams(context, ws, message, parsed.error.issues[0]?.message);
        return;
      }
      const { threadId, afterSeq = 0 } = parsed.data;
      const binding = context.threads.load(threadId);
      if (!binding?.runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `Unknown thread: ${threadId}`,
        });
        return;
      }
      context.journal.flushProjection?.(threadId);
      await context.journal.waitForIdle(threadId);
      const thread = context.utils.buildThreadFromSession(binding.runtime);
      let replayedRequestIds: ReadonlySet<string> | undefined;
      const replayHealth = buildReplayHealth(context, threadId, afterSeq);
      if (afterSeq > 0) {
        binding.runtime.replay.beginDisconnectedReplayBuffer();
        if (!replayHealth || replayHealth.trusted) {
          replayedRequestIds = context.journal.replay(ws, threadId, afterSeq);
        }
      }
      const pendingPromptEvents = binding.runtime.replay.getPendingPromptEventsForReplay();
      context.threads.subscribe(ws, threadId, {
        ...(afterSeq > 0 ? { drainDisconnectedReplayBuffer: true } : {}),
        pendingPromptEvents,
        ...(replayedRequestIds?.size ? { skipPendingPromptRequestIds: replayedRequestIds } : {}),
      });
      context.jsonrpc.sendResult(ws, message.id, {
        thread,
        ...(replayHealth ? { replayHealth } : {}),
      });
      context.jsonrpc.send(ws, { method: "thread/started", params: { thread } });
    },

    "thread/list": async (ws, message) => {
      const parsed = jsonRpcThreadTurnRequestSchemas["thread/list"].safeParse(message.params ?? {});
      if (!parsed.success) {
        sendInvalidParams(context, ws, message, parsed.error.issues[0]?.message);
        return;
      }
      let cwd: string;
      try {
        cwd = await resolveThreadListWorkspacePath(context, parsed.data, message.method);
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : `${message.method} requires cwd`,
        });
        return;
      }
      const { threads, total } = listWorkspaceChatThreads(context, {
        cwd,
        offset: parsed.data.offset,
        limit: parsed.data.limit,
      });
      context.jsonrpc.sendResult(ws, message.id, {
        threads,
        total,
      });
    },

    "thread/read": async (ws, message) => {
      const parsed = jsonRpcThreadTurnRequestSchemas["thread/read"].safeParse(message.params);
      if (!parsed.success) {
        sendInvalidParams(context, ws, message, parsed.error.issues[0]?.message);
        return;
      }
      await sendThreadReadResult(ws, message, parsed.data);
    },

    "thread/hydrate": async (ws, message) => {
      const parsed = jsonRpcThreadTurnRequestSchemas["thread/hydrate"].safeParse(message.params);
      if (!parsed.success) {
        sendInvalidParams(context, ws, message, parsed.error.issues[0]?.message);
        return;
      }
      await sendThreadReadResult(ws, message, parsed.data);
    },

    "thread/unsubscribe": (ws, message) => {
      const parsed = jsonRpcThreadTurnRequestSchemas["thread/unsubscribe"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        sendInvalidParams(context, ws, message, parsed.error.issues[0]?.message);
        return;
      }
      const { threadId } = parsed.data;
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
