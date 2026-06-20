import type { TaskRecord } from "../../../../src/shared/tasks";
import { isStandardChatThread } from "./threadFilters";
import type { ThreadRecord } from "./types";

type SandboxApprovalContext = {
  view: string;
  selectedTaskId: string | null;
  selectedThreadId: string | null;
  threads: ThreadRecord[];
  tasksById: Record<string, TaskRecord>;
};

export type SandboxApprovalThreadTarget =
  | { kind: "chat" }
  | { kind: "task"; taskId: string; taskThreadId: string | null };

export function resolveSandboxApprovalThreadTarget(
  context: Pick<SandboxApprovalContext, "selectedThreadId" | "threads" | "tasksById">,
  threadId: string,
): SandboxApprovalThreadTarget | null {
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
    (thread && isStandardChatThread(thread, { includeDrafts: true })) ||
    threadId === context.selectedThreadId
  ) {
    return { kind: "chat" };
  }
  return null;
}

export function isSandboxApprovalThreadVisible(
  context: SandboxApprovalContext,
  threadId: string,
): boolean {
  const target = resolveSandboxApprovalThreadTarget(context, threadId);
  if (!target) return false;
  if (context.view === "task") {
    if (target.kind !== "task" || target.taskId !== context.selectedTaskId) return false;
    return true;
  }
  return context.view === "chat" && target.kind === "chat";
}
