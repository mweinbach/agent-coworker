import type { ProjectedItem } from "../../shared/projectedItems";
import type { SessionEvent } from "../protocol";
import {
  developerDiagnosticSystemLineFromSessionEvent,
  formatApprovalSystemLine,
  formatAskSystemLine,
  shouldSuppressRawDebugLogLine,
} from "./conversationProjectionDiagnostics";
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

  const emitA2uiSurfaceItem = (evt: Extract<SessionEvent, { type: "a2ui_surface" }>) => {
    const item: ProjectedItem = {
      id: makeItemId("uiSurface", `${evt.surfaceId}@${evt.revision}`),
      type: "uiSurface",
      surfaceId: evt.surfaceId,
      catalogId: evt.catalogId,
      version: evt.version,
      revision: evt.revision,
      deleted: evt.deleted,
      ...(evt.theme ? { theme: evt.theme } : {}),
      ...(evt.root ? { root: evt.root } : {}),
      ...(evt.dataModel !== undefined ? { dataModel: evt.dataModel } : {}),
      ...(evt.changeKind ? { changeKind: evt.changeKind } : {}),
      ...(evt.reason ? { reason: evt.reason } : {}),
      ...(evt.toolCallId ? { toolCallId: evt.toolCallId } : {}),
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
    };
    state.opts.sink.emitItemStarted(null, item);
    state.opts.sink.emitItemCompleted(null, item);
  };

  const emitServerRequest = (request: ProjectionServerRequest) => {
    state.opts.sink.emitServerRequest?.(request);
  };

  return {
    emitSystemItem,
    emitLogItem,
    emitTodosItem,
    emitA2uiSurfaceItem,
    emitErrorItem,
    emitServerRequest,
    shouldSuppressRawDebugLogLine,
  };
}

export type FeedItemProjection = ReturnType<typeof createFeedItemProjection>;
