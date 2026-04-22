import type { ThreadRecord } from "../app/types";

export function canPopOutQuickChatThread(thread: Pick<ThreadRecord, "draft"> | null | undefined): boolean {
  return thread != null && thread.draft !== true;
}
