export function isTaskOwnedThread(thread: { taskId?: string | null }): boolean {
  return typeof thread.taskId === "string" && thread.taskId.trim().length > 0;
}

export function isStandardChatThread(
  thread: { taskId?: string | null; draft?: boolean; archived?: boolean },
  options: { includeDrafts?: boolean; includeArchived?: boolean } = {},
): boolean {
  if (isTaskOwnedThread(thread)) return false;
  if (!options.includeDrafts && thread.draft) return false;
  if (!options.includeArchived && thread.archived) return false;
  return true;
}
