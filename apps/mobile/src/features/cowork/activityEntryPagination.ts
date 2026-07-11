export const ACTIVITY_INLINE_PAGE_SIZE = 24;

export type ActivityEntryPage<Entry> = {
  entries: Entry[];
  startIndex: number;
  endIndexExclusive: number;
  totalCount: number;
  hiddenBefore: number;
  hiddenAfter: number;
};

export function buildActivityEntryPage<Entry>(
  entries: readonly Entry[],
  requestedStartIndex: number | null,
): ActivityEntryPage<Entry> {
  const latestStart = Math.max(0, entries.length - ACTIVITY_INLINE_PAGE_SIZE);
  const startIndex =
    requestedStartIndex === null
      ? latestStart
      : Math.min(latestStart, Math.max(0, Math.floor(requestedStartIndex)));
  const endIndexExclusive = Math.min(entries.length, startIndex + ACTIVITY_INLINE_PAGE_SIZE);

  return {
    entries: entries.slice(startIndex, endIndexExclusive),
    startIndex,
    endIndexExclusive,
    totalCount: entries.length,
    hiddenBefore: startIndex,
    hiddenAfter: entries.length - endIndexExclusive,
  };
}

export function previousActivityPageStart<Entry>(page: ActivityEntryPage<Entry>): number {
  return Math.max(0, page.startIndex - ACTIVITY_INLINE_PAGE_SIZE);
}

export function nextActivityPageStart<Entry>(page: ActivityEntryPage<Entry>): number | null {
  const latestStart = Math.max(0, page.totalCount - ACTIVITY_INLINE_PAGE_SIZE);
  const nextStart = page.startIndex + ACTIVITY_INLINE_PAGE_SIZE;
  return nextStart >= latestStart ? null : nextStart;
}
