import type { ServerEvent } from "../protocol";
import type { PersistedThreadJournalEvent } from "../sessionDb";
import { createProjectionCore } from "./projectionCore";
import type { ProjectedEvent } from "./projectionCore.types";

type ThreadJournalEmission = Omit<PersistedThreadJournalEvent, "seq">;

type CreateThreadJournalProjectorOptions = {
  threadId: string;
  emit: (event: ThreadJournalEmission) => void;
};

export function createThreadJournalProjector(opts: CreateThreadJournalProjectorOptions) {
  const emit = (eventType: string, payload: unknown, meta?: {
    turnId?: string | null;
    itemId?: string | null;
    requestId?: string | null;
  }) => {
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

  const handleProjectedEvent = (event: ProjectedEvent) => {
    switch (event.type) {
      case "turn/started":
        emit("turn/started", {
          threadId: opts.threadId,
          turn: event.turn,
        }, { turnId: event.turnId });
        return;
      case "turn/completed":
        emit("turn/completed", {
          threadId: opts.threadId,
          turn: event.turn,
        }, { turnId: event.turnId });
        return;
      case "item/started":
        emit("item/started", {
          threadId: opts.threadId,
          turnId: event.turnId,
          item: event.item,
        }, { turnId: event.turnId, itemId: event.item.id });
        return;
      case "item/completed":
        emit("item/completed", {
          threadId: opts.threadId,
          turnId: event.turnId,
          item: event.item,
        }, { turnId: event.turnId, itemId: event.item.id });
        return;
      case "item/agentMessage/delta":
        emit("item/agentMessage/delta", {
          threadId: opts.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          delta: event.delta,
        }, { turnId: event.turnId, itemId: event.itemId });
        return;
      case "item/reasoning/delta":
        emit("item/reasoning/delta", {
          threadId: opts.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          mode: event.mode,
          delta: event.delta,
        }, { turnId: event.turnId, itemId: event.itemId });
        return;
      case "ask":
        emit("request:item/tool/requestUserInput", {
          threadId: opts.threadId,
          turnId: event.turnId,
          requestId: event.requestId,
          itemId: event.itemId,
          question: event.question,
          ...(event.options ? { options: event.options } : {}),
        }, { turnId: event.turnId, requestId: event.requestId, itemId: event.itemId });
        return;
      case "approval":
        emit("request:item/commandExecution/requestApproval", {
          threadId: opts.threadId,
          turnId: event.turnId,
          requestId: event.requestId,
          itemId: event.itemId,
          command: event.command,
          dangerous: event.dangerous,
          reason: event.reason,
        }, { turnId: event.turnId, requestId: event.requestId, itemId: event.itemId });
        return;
    }
  };

  const core = createProjectionCore({
    threadId: opts.threadId,
    sink: { emit: handleProjectedEvent },
  });

  return {
    handle(event: ServerEvent) {
      core.handle(event);
    },
  };
}
