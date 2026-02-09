import type { ThreadRecord } from "../app/types";

export function selectSidebarThreadsForWorkspace(threads: ThreadRecord[], workspaceId: string): ThreadRecord[] {
  return threads
    .filter((t) => t.workspaceId === workspaceId && t.status !== "archived")
    .slice()
    .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));
}

