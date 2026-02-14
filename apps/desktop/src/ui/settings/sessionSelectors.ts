import type { ThreadRecord } from "../../app/types";

export function selectArchivedThreadsSorted(threads: ThreadRecord[]): ThreadRecord[] {
  return threads
    .filter((t) => t.status === "archived")
    .slice()
    .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));
}

