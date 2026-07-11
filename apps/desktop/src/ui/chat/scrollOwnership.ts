export const FOLLOW_TAIL_THRESHOLD_PX = 48;

export type ScrollAnchorPosition = {
  anchorId: string;
  offset: number;
};

export function scrollDistanceFromEnd(viewport: HTMLElement): number {
  return Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
}

export function isNearScrollEnd(
  viewport: HTMLElement,
  threshold = FOLLOW_TAIL_THRESHOLD_PX,
): boolean {
  return scrollDistanceFromEnd(viewport) <= threshold;
}

function scrollAnchorId(item: HTMLElement): string | undefined {
  return item.dataset.scrollAnchorId ?? item.dataset.messageId;
}

function scrollAnchorItems(content: HTMLElement): HTMLElement[] {
  return Array.from(content.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && typeof scrollAnchorId(child) === "string",
  );
}

export function captureScrollAnchor(
  viewport: HTMLElement,
  content: HTMLElement,
): ScrollAnchorPosition | null {
  const viewportTop = viewport.getBoundingClientRect().top;
  for (const item of scrollAnchorItems(content)) {
    const itemRect = item.getBoundingClientRect();
    if (itemRect.bottom > viewportTop) {
      const anchorId = scrollAnchorId(item);
      if (!anchorId) continue;
      return {
        anchorId,
        offset: itemRect.top - viewportTop,
      };
    }
  }
  return null;
}

export function restoreScrollAnchor(
  viewport: HTMLElement,
  content: HTMLElement,
  position: ScrollAnchorPosition,
): boolean {
  const item = scrollAnchorItems(content).find(
    (candidate) => scrollAnchorId(candidate) === position.anchorId,
  );
  if (!item) return false;
  const currentOffset = item.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  const delta = currentOffset - position.offset;
  if (Math.abs(delta) > 0.5) {
    viewport.scrollTop = Math.max(0, viewport.scrollTop + delta);
  }
  return true;
}

export function scrollViewportToEnd(viewport: HTMLElement): void {
  viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
}

export function countNewIds(previousIds: readonly string[], currentIds: readonly string[]): number {
  if (previousIds.length === 0) return 0;
  const previous = new Set(previousIds);
  const previousTailId = previousIds[previousIds.length - 1];
  const previousTailIndex = previousTailId ? currentIds.lastIndexOf(previousTailId) : -1;
  const candidates = previousTailIndex >= 0 ? currentIds.slice(previousTailIndex + 1) : currentIds;
  let count = 0;
  for (const id of candidates) {
    if (!previous.has(id)) count += 1;
  }
  return count;
}
