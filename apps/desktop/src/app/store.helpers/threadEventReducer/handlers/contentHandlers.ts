import type { SessionEvent } from "../../../../lib/wsProtocol";
import { clearPendingThreadSteers } from "../../runtimeState";
import type { HandlerDispatch, HandlerModuleContext } from "./shared";

export function handleContentThreadEvent(
  module: HandlerModuleContext,
  dispatch: HandlerDispatch,
  evt: SessionEvent,
): boolean {
  const { ctx, pushFeedItem } = module;
  const { get, set, threadId } = dispatch;

  if (evt.type === "turn_usage") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            lastTurnUsage: {
              turnId: evt.turnId,
              usage: evt.usage,
            },
          },
        },
      };
    });
    return true;
  }

  if (evt.type === "session_usage") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            sessionUsage: evt.usage,
          },
        },
      };
    });
    return true;
  }

  if (evt.type === "budget_warning" || evt.type === "budget_exceeded") {
    set((s) => ({
      notifications: ctx.deps.pushNotification(s.notifications, {
        id: ctx.deps.makeId(),
        ts: ctx.deps.nowIso(),
        kind: evt.type === "budget_exceeded" ? "error" : "info",
        title:
          evt.type === "budget_exceeded" ? "Session hard cap exceeded" : "Session budget warning",
        detail: evt.message,
      }),
    }));
    return true;
  }

  if (evt.type === "todos") {
    set((s) => ({
      latestTodosByThreadId: { ...s.latestTodosByThreadId, [threadId]: evt.todos },
    }));
    pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "todos",
      ts: ctx.deps.nowIso(),
      todos: evt.todos,
    });
    return true;
  }

  if (evt.type === "log") {
    pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "log",
      ts: ctx.deps.nowIso(),
      line: evt.line,
    });
    return true;
  }

  if (evt.type === "error") {
    pushFeedItem(set, threadId, {
      id: ctx.deps.makeId(),
      kind: "error",
      ts: ctx.deps.nowIso(),
      message: evt.message,
      code: evt.code,
      source: evt.source,
    });
    set((s) => ({
      notifications: ctx.deps.pushNotification(s.notifications, {
        id: ctx.deps.makeId(),
        ts: ctx.deps.nowIso(),
        kind: "error",
        title: "Agent error",
        detail: `${evt.source}/${evt.code}: ${evt.message}`,
      }),
    }));
    const pendingSteer = get().threadRuntimeById[threadId]?.pendingSteer;
    if (
      evt.steerRequestId &&
      pendingSteer?.steerRequestId &&
      evt.steerRequestId === pendingSteer.steerRequestId
    ) {
      const submissionId = pendingSteer.submissionId;
      if (submissionId) get().failComposerSubmission(submissionId, new Error(evt.message));
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (rt?.pendingSteer?.steerRequestId !== evt.steerRequestId) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              pendingSteer: null,
            },
          },
        };
      });
      clearPendingThreadSteers(threadId);
    }
    return true;
  }

  return false;
}
