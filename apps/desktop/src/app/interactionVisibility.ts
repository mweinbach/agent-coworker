import type { TaskRecord } from "../../../../src/shared/tasks";
import { isStandardChatThread } from "./threadFilters";
import { getThreadSelectionContext } from "./threadSelectionContext";
import type { ThreadRecord, ViewId } from "./types";

type InteractionContext = {
  view: ViewId;
  lastNonSettingsView?: ViewId | null;
  selectedTaskId: string | null;
  selectedThreadId: string | null;
  threads: ThreadRecord[];
  tasksById: Record<string, TaskRecord>;
};

export type InteractionThreadTarget =
  | { kind: "chat" }
  | { kind: "task"; taskId: string; taskThreadId: string | null };

export function resolveInteractionThreadTarget(
  context: Pick<InteractionContext, "selectedThreadId" | "threads" | "tasksById">,
  threadId: string,
): InteractionThreadTarget | null {
  const thread = context.threads.find((candidate) => candidate.id === threadId);
  const directTaskId = thread?.taskId ?? null;
  if (directTaskId) {
    const task = context.tasksById[directTaskId];
    const taskThreadId =
      thread?.taskThreadId ??
      task?.threads.find((candidate) => candidate.sessionId === threadId)?.id ??
      null;
    return { kind: "task", taskId: directTaskId, taskThreadId };
  }

  for (const task of Object.values(context.tasksById)) {
    const taskThread = task.threads.find((candidate) => candidate.sessionId === threadId);
    if (taskThread) {
      return { kind: "task", taskId: task.id, taskThreadId: taskThread.id };
    }
  }

  if (
    (thread && isStandardChatThread(thread, { includeDrafts: true, includeArchived: true })) ||
    threadId === context.selectedThreadId
  ) {
    return { kind: "chat" };
  }
  return null;
}

export function isInteractionThreadVisible(context: InteractionContext, threadId: string): boolean {
  const thread = context.threads.find((candidate) => candidate.id === threadId);
  if (thread?.archived) return false;
  const target = resolveInteractionThreadTarget(context, threadId);
  if (!target) return false;
  const selectionContext = getThreadSelectionContext(context.view, context.lastNonSettingsView);
  if (selectionContext === "task") {
    return target.kind === "task" && target.taskId === context.selectedTaskId;
  }
  return target.kind === "chat";
}
