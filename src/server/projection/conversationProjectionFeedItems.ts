import type { ProjectedItem } from "../../shared/projectedItems";
import type { SessionEvent } from "../protocol";
import { shouldSuppressRawDebugLogLine } from "./conversationProjectionDiagnostics";
import type { ConversationProjectionState } from "./conversationProjectionState";
import type { ProjectionServerRequest } from "./conversationProjectionTypes";
import { makeItemId } from "./shared";

export function createFeedItemProjection(state: ConversationProjectionState) {
  const emitSystemItem = (line: string) => {
    const item: ProjectedItem = {
      id: makeItemId("system", crypto.randomUUID()),
      type: "system",
      line,
    };
    state.opts.sink.emitItemStarted(null, item);
    state.opts.sink.emitItemCompleted(null, item);
  };

  const emitLogItem = (line: string) => {
    if (shouldSuppressRawDebugLogLine(line)) return;
    const item: ProjectedItem = {
      id: makeItemId("log", crypto.randomUUID()),
      type: "log",
      line,
    };
    state.opts.sink.emitItemStarted(null, item);
    state.opts.sink.emitItemCompleted(null, item);
  };

  const emitTodosItem = (todos: Extract<SessionEvent, { type: "todos" }>["todos"]) => {
    const item: ProjectedItem = {
      id: makeItemId("todos", crypto.randomUUID()),
      type: "todos",
      todos,
    };
    state.opts.sink.emitItemStarted(null, item);
    state.opts.sink.emitItemCompleted(null, item);
  };

  const emitErrorItem = (evt: Extract<SessionEvent, { type: "error" }>) => {
    const item: ProjectedItem = {
      id: makeItemId("error", crypto.randomUUID()),
      type: "error",
      message: evt.message,
      code: evt.code,
      source: evt.source,
      ...(evt.data !== undefined ? { data: evt.data } : {}),
      ...(evt.clientMessageId ? { clientMessageId: evt.clientMessageId } : {}),
      ...(evt.steerRequestId ? { steerRequestId: evt.steerRequestId } : {}),
    };
    // Attach mid-turn errors to their turn: thread/read reconstruction drops
    // items without a turnId, so a failed turn's cause would otherwise vanish
    // from the journal-backed transcript.
    const turnId = state.activeTurnId ?? null;
    state.opts.sink.emitItemStarted(turnId, item);
    state.opts.sink.emitItemCompleted(turnId, item);
  };

  const emitServerRequest = (request: ProjectionServerRequest) => {
    state.opts.sink.emitServerRequest?.(request);
  };

  return {
    emitSystemItem,
    emitLogItem,
    emitTodosItem,
    emitErrorItem,
    emitServerRequest,
    shouldSuppressRawDebugLogLine,
  };
}

export type FeedItemProjection = ReturnType<typeof createFeedItemProjection>;
