import { createConversationProjection } from "../projection/conversationProjection";
import type { SessionEvent } from "../protocol";
import type { PersistedThreadJournalEvent } from "../sessionDb";

type ThreadJournalEmission = Omit<PersistedThreadJournalEvent, "seq">;

type CreateThreadJournalNotificationProjectorOptions = {
  threadId: string;
  emit: (event: ThreadJournalEmission) => void;
};

export function createThreadJournalNotificationProjector(
  opts: CreateThreadJournalNotificationProjectorOptions,
) {
  const emit = (
    eventType: string,
    payload: unknown,
    meta?: {
      turnId?: string | null;
      itemId?: string | null;
      requestId?: string | null;
    },
  ) => {
    opts.emit({
      threadId: opts.threadId,
      ts: new Date().toISOString(),
      eventType,
      turnId: meta?.turnId ?? null,
      itemId: meta?.itemId ?? null,
      requestId: meta?.requestId ?? null,
      payload,
    });
  };

  const projection = createConversationProjection({
    sink: {
      emitTurnStarted: (turnId) => {
        emit(
          "turn/started",
          {
            threadId: opts.threadId,
            turn: {
              id: turnId,
              status: "inProgress",
              items: [],
            },
          },
          { turnId },
        );
      },
      emitTurnCompleted: (turnId, status) => {
        emit(
          "turn/completed",
          {
            threadId: opts.threadId,
            turn: {
              id: turnId,
              status,
            },
          },
          { turnId },
        );
      },
      emitItemStarted: (turnId, item) => {
        emit(
          "item/started",
          {
            threadId: opts.threadId,
            turnId,
            item,
          },
          { turnId, itemId: item.id },
        );
      },
      emitReasoningDelta: (turnId, itemId, mode, delta) => {
        emit(
          "item/reasoning/delta",
          {
            threadId: opts.threadId,
            turnId,
            itemId,
            mode,
            delta,
          },
          { turnId, itemId },
        );
      },
      emitAgentMessageDelta: (turnId, itemId, delta) => {
        emit(
          "item/agentMessage/delta",
          {
            threadId: opts.threadId,
            turnId,
            itemId,
            delta,
          },
          { turnId, itemId },
        );
      },
      emitItemCompleted: (turnId, item) => {
        emit(
          "item/completed",
          {
            threadId: opts.threadId,
            turnId,
            item,
          },
          { turnId, itemId: item.id },
        );
      },
      emitServerRequest: (request) => {
        emit(
          `request:${request.method}`,
          {
            threadId: opts.threadId,
            ...request.params,
          },
          {
            turnId: request.params.turnId,
            requestId: request.params.requestId,
            itemId: request.params.itemId,
          },
        );
      },
    },
  });

  return {
    handle(event: SessionEvent) {
      if (event.sessionId !== opts.threadId) return;
      projection.handle(event);
    },
  };
}
