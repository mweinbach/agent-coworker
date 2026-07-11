export const FOLLOW_TAIL_THRESHOLD_PX = 48;

export type ScrollAnchorPosition = {
  anchorId: string;
  offset: number;
  textAnchor?: {
    characterOffset: number;
    offset: number;
    textAfter: string;
    textBefore: string;
  };
};

const TEXT_ANCHOR_CONTEXT_LENGTH = 32;

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

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offset: number; offsetNode: Node } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function rangeRect(range: Range): DOMRect | null {
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  return Number.isFinite(rect.top) ? rect : null;
}

function caretRangeAtPoint(document: CaretDocument, x: number, y: number): Range | null {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) {
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return document.caretRangeFromPoint?.(x, y) ?? null;
}

function captureTextAnchor(
  viewport: HTMLElement,
  item: HTMLElement,
): ScrollAnchorPosition["textAnchor"] | undefined {
  const document = item.ownerDocument as CaretDocument;
  if (!document.caretPositionFromPoint && !document.caretRangeFromPoint) return undefined;
  const viewportRect = viewport.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const rightEdge = Math.min(viewportRect.right, itemRect.right) - 1;
  const bottomEdge = Math.min(viewportRect.bottom, itemRect.bottom) - 1;
  const x = Math.min(rightEdge, Math.max(viewportRect.left, itemRect.left) + 16);
  const y = Math.min(bottomEdge, Math.max(viewportRect.top, itemRect.top) + 1);
  if (
    x < Math.max(viewportRect.left, itemRect.left) ||
    y < Math.max(viewportRect.top, itemRect.top)
  ) {
    return undefined;
  }

  const caretRange = caretRangeAtPoint(document, x, y);
  const node = caretRange?.startContainer;
  if (!caretRange || !node || (node !== item && !item.contains(node))) return undefined;
  const caretRect = rangeRect(caretRange);
  if (!caretRect) return undefined;

  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(item);
  prefixRange.setEnd(node, caretRange.startOffset);
  const characterOffset = prefixRange.toString().length;
  const text = item.textContent ?? "";
  return {
    characterOffset,
    offset: caretRect.top - viewportRect.top,
    textBefore: text.slice(
      Math.max(0, characterOffset - TEXT_ANCHOR_CONTEXT_LENGTH),
      characterOffset,
    ),
    textAfter: text.slice(characterOffset, characterOffset + TEXT_ANCHOR_CONTEXT_LENGTH),
  };
}

function resolveTextOffset(
  text: string,
  textAnchor: NonNullable<ScrollAnchorPosition["textAnchor"]>,
): number {
  const context = `${textAnchor.textBefore}${textAnchor.textAfter}`;
  if (context) {
    const contextIndex = text.indexOf(context);
    if (contextIndex >= 0) return contextIndex + textAnchor.textBefore.length;
  }
  if (textAnchor.textAfter) {
    const afterIndex = text.indexOf(textAnchor.textAfter);
    if (afterIndex >= 0) return afterIndex;
  }
  if (textAnchor.textBefore) {
    const beforeIndex = text.lastIndexOf(textAnchor.textBefore);
    if (beforeIndex >= 0) return beforeIndex + textAnchor.textBefore.length;
  }
  return Math.min(text.length, textAnchor.characterOffset);
}

function restoreTextAnchor(
  viewport: HTMLElement,
  item: HTMLElement,
  textAnchor: NonNullable<ScrollAnchorPosition["textAnchor"]>,
): boolean {
  const document = item.ownerDocument;
  const targetOffset = resolveTextOffset(item.textContent ?? "", textAnchor);
  const walker = document.createTreeWalker(item, 4);
  let remaining = targetOffset;
  let node = walker.nextNode();
  let lastTextNode: Text | null = null;
  while (node) {
    if (node.nodeType === 3) {
      const textNode = node as Text;
      lastTextNode = textNode;
      if (remaining <= textNode.data.length) {
        const range = document.createRange();
        range.setStart(textNode, remaining);
        range.collapse(true);
        const rect = rangeRect(range);
        if (!rect) return false;
        const delta = rect.top - viewport.getBoundingClientRect().top - textAnchor.offset;
        if (Math.abs(delta) > 0.5) {
          viewport.scrollTop = Math.max(0, viewport.scrollTop + delta);
        }
        return true;
      }
      remaining -= textNode.data.length;
    }
    node = walker.nextNode();
  }
  if (!lastTextNode) return false;
  const range = document.createRange();
  range.setStart(lastTextNode, lastTextNode.data.length);
  range.collapse(true);
  const rect = rangeRect(range);
  if (!rect) return false;
  const delta = rect.top - viewport.getBoundingClientRect().top - textAnchor.offset;
  if (Math.abs(delta) > 0.5) {
    viewport.scrollTop = Math.max(0, viewport.scrollTop + delta);
  }
  return true;
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
        textAnchor: captureTextAnchor(viewport, item),
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
  if (position.textAnchor && restoreTextAnchor(viewport, item, position.textAnchor)) {
    return true;
  }
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
