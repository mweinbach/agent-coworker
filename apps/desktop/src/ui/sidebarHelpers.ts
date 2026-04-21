const MAX_VISIBLE_THREADS = 10;

export function formatSidebarRelativeAge(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (elapsedMs < minute) return "now";
  if (elapsedMs < hour) return `${Math.floor(elapsedMs / minute)}m`;
  if (elapsedMs < day) return `${Math.floor(elapsedMs / hour)}h`;
  if (elapsedMs < week) return `${Math.floor(elapsedMs / day)}d`;
  if (elapsedMs < month) return `${Math.floor(elapsedMs / week)}w`;
  if (elapsedMs < year) return `${Math.floor(elapsedMs / month)}mo`;
  return `${Math.floor(elapsedMs / year)}y`;
}

export function getVisibleSidebarThreads<T>(threads: T[], showAll: boolean, limit = MAX_VISIBLE_THREADS): {
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
  if (sourceId === targetId) {
    return items;
  }

  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);

  if (sourceIndex === -1 || targetIndex === -1) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(sourceIndex, 1);
  nextItems.splice(targetIndex, 0, movedItem);
  return nextItems;
}

export function applyWorkspaceOrder<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const seenIds = new Set<string>();
  const nextItems: T[] = [];

  for (const id of orderedIds) {
    if (seenIds.has(id)) {
      continue;
    }
    const item = itemsById.get(id);
    if (!item) {
      continue;
    }
    seenIds.add(id);
    nextItems.push(item);
  }

  for (const item of items) {
    if (seenIds.has(item.id)) {
      continue;
    }
    nextItems.push(item);
  }

  const unchanged = nextItems.length === items.length
    && nextItems.every((item, index) => item === items[index]);
  return unchanged ? items : nextItems;
}

export function swapSidebarItemsById<T extends { id: string }>(
  items: T[],
  itemId: string,
  direction: "up" | "down",
): T[] {
  const sourceIndex = items.findIndex((item) => item.id === itemId);
  if (sourceIndex === -1) {
    return items;
  }

  const targetIndex = direction === "up" ? sourceIndex - 1 : sourceIndex + 1;
  if (targetIndex < 0 || targetIndex >= items.length) {
    return items;
  }

  const nextItems = [...items];
  [nextItems[sourceIndex], nextItems[targetIndex]] = [nextItems[targetIndex] as T, nextItems[sourceIndex] as T];
  return nextItems;
}

export function shouldEmphasizeWorkspaceRow(
  isSelectedWorkspace: boolean,
  selectedThreadId: string | null,
  workspaceThreadIds: string[],
): boolean {
  if (!isSelectedWorkspace) {
    return false;
  }

  if (!selectedThreadId) {
    return true;
  }

  return !workspaceThreadIds.includes(selectedThreadId);
}
