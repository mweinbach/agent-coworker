import { isStandardChatThread } from "../app/threadFilters";

export const MAX_VISIBLE_SIDEBAR_ITEMS = 5;

export function groupStandardChatThreadsByWorkspace<
  T extends {
    workspaceId: string;
    lastMessageAt: string;
    archived?: boolean;
    taskId?: string;
  },
>(threads: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const thread of threads) {
    if (!isStandardChatThread(thread, { includeDrafts: true })) continue;
    const bucket = grouped.get(thread.workspaceId);
    if (bucket) bucket.push(thread);
    else grouped.set(thread.workspaceId, [thread]);
  }
  for (const workspaceThreads of grouped.values()) {
    workspaceThreads.sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));
  }
  return grouped;
}

const AGE_UNITS = [
  [365 * 86_400_000, "y"],
  [30 * 86_400_000, "mo"],
  [7 * 86_400_000, "w"],
  [86_400_000, "d"],
  [3_600_000, "h"],
  [60_000, "m"],
] as const;

export function formatSidebarRelativeAge(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";

  const elapsedMs = Math.max(0, Date.now() - timestamp);
  for (const [unitMs, suffix] of AGE_UNITS) {
    if (elapsedMs >= unitMs) return `${Math.floor(elapsedMs / unitMs)}${suffix}`;
  }
  return "now";
}

export function getVisibleSidebarThreads<T>(
  threads: T[],
  showAll: boolean,
  limit = MAX_VISIBLE_SIDEBAR_ITEMS,
): {
  visibleThreads: T[];
  hiddenThreadCount: number;
} {
  const visibleThreads = showAll ? threads : threads.slice(0, limit);
  return {
    visibleThreads,
    hiddenThreadCount: Math.max(0, threads.length - visibleThreads.length),
  };
}

export function reorderSidebarItemsById<T extends { id: string }>(
  items: T[],
  sourceId: string,
  targetId: string,
): T[] {
  if (sourceId === targetId) return items;

  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1) return items;

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(sourceIndex, 1);
  nextItems.splice(targetIndex, 0, movedItem);
  return nextItems;
}

export function applyWorkspaceOrder<T extends { id: string }>(
  items: T[],
  orderedIds: string[],
): T[] {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const seenIds = new Set<string>();
  const nextItems: T[] = [];

  for (const id of orderedIds) {
    if (seenIds.has(id)) continue;
    const item = itemsById.get(id);
    if (!item) continue;
    seenIds.add(id);
    nextItems.push(item);
  }

  for (const item of items) {
    if (!seenIds.has(item.id)) nextItems.push(item);
  }

  const unchanged =
    nextItems.length === items.length && nextItems.every((item, index) => item === items[index]);
  return unchanged ? items : nextItems;
}

export function swapSidebarItemsById<T extends { id: string }>(
  items: T[],
  itemId: string,
  direction: "up" | "down",
): T[] {
  const sourceIndex = items.findIndex((item) => item.id === itemId);
  const targetIndex = direction === "up" ? sourceIndex - 1 : sourceIndex + 1;
  if (sourceIndex === -1 || targetIndex < 0 || targetIndex >= items.length) {
    return items;
  }

  const nextItems = [...items];
  [nextItems[sourceIndex], nextItems[targetIndex]] = [
    nextItems[targetIndex] as T,
    nextItems[sourceIndex] as T,
  ];
  return nextItems;
}

export function shouldEmphasizeWorkspaceRow(
  isSelectedWorkspace: boolean,
  selectedThreadId: string | null,
  workspaceThreadIds: string[],
): boolean {
  return (
    isSelectedWorkspace && (!selectedThreadId || !workspaceThreadIds.includes(selectedThreadId))
  );
}
