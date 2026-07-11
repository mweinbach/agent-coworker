export type ComposerCaretAnchor = {
  bottom: number;
  left: number;
  lineHeight: number;
  right: number;
  top: number;
};

export type ComposerMentionMenuPlacement = {
  left: number;
  maxHeight: number;
  placement: "above" | "below";
  top: number;
};

const TEXT_GEOMETRY_PROPERTIES = [
  "direction",
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-optical-sizing",
  "font-size",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-variation-settings",
  "font-weight",
  "letter-spacing",
  "line-height",
  "overflow-wrap",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "tab-size",
  "text-align",
  "text-align-last",
  "text-indent",
  "text-rendering",
  "text-transform",
  "text-size-adjust",
  "unicode-bidi",
  "white-space",
  "word-break",
  "word-spacing",
  "writing-mode",
] as const;

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundToDevicePixel(value: number, devicePixelRatio: number): number {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.round(value * scale) / scale;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/**
 * Makes the read-only overlay use the textarea's resolved metrics and client
 * box. Using computed values instead of duplicated classes keeps fallback
 * fonts, delayed web fonts, zoom rounding, and scrollbar gutters identical.
 */
export function syncComposerOverlayGeometry(
  textarea: HTMLTextAreaElement,
  overlay: HTMLDivElement,
): void {
  const computed = getComputedStyle(textarea);
  for (const property of TEXT_GEOMETRY_PROPERTIES) {
    overlay.style.setProperty(property, computed.getPropertyValue(property));
  }

  overlay.style.boxSizing = "border-box";
  overlay.style.left = `${textarea.offsetLeft + textarea.clientLeft}px`;
  overlay.style.top = `${textarea.offsetTop + textarea.clientTop}px`;
  overlay.style.width = `${textarea.clientWidth}px`;
  overlay.style.height = `${textarea.clientHeight}px`;
  overlay.scrollLeft = textarea.scrollLeft;
  overlay.scrollTop = textarea.scrollTop;
}

function firstRangeRect(range: Range): DOMRect | null {
  const rects = typeof range.getClientRects === "function" ? range.getClientRects() : null;
  if (rects && rects.length > 0) return rects[0] ?? null;
  if (typeof range.getBoundingClientRect !== "function") return null;
  const rect = range.getBoundingClientRect();
  return rect.width !== 0 || rect.height !== 0 || rect.x !== 0 || rect.y !== 0 ? rect : null;
}

/**
 * Measures a collapsed DOM range in the metric mirror. The range adds no node
 * or glyph, so measuring the picker anchor cannot affect wrapping.
 */
export function measureComposerCaretAnchor(
  overlay: HTMLDivElement,
  caret: number,
  textLength: number,
): ComposerCaretAnchor | null {
  const target = Math.max(0, Math.min(caret, textLength));
  const walker = document.createTreeWalker(overlay, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (target <= consumed + length) {
      const range = document.createRange();
      range.setStart(node, target - consumed);
      range.collapse(true);
      const rect = firstRangeRect(range);
      if (!rect) return null;
      const computedLineHeight = cssPixels(getComputedStyle(overlay).lineHeight);
      const lineHeight = rect.height || computedLineHeight;
      return {
        bottom: rect.height ? rect.bottom : rect.top + lineHeight,
        left: rect.left,
        lineHeight,
        right: rect.left,
        top: rect.height ? rect.top : rect.top,
      };
    }
    consumed += length;
    node = walker.nextNode();
  }
  return null;
}

export function fallbackComposerCaretAnchor(textarea: HTMLTextAreaElement): ComposerCaretAnchor {
  const rect = textarea.getBoundingClientRect();
  const computed = getComputedStyle(textarea);
  const lineHeight = cssPixels(computed.lineHeight) || cssPixels(computed.fontSize);
  const left = rect.left + cssPixels(computed.paddingLeft);
  const top = rect.top + cssPixels(computed.paddingTop);
  return {
    bottom: top + lineHeight,
    left,
    lineHeight,
    right: left,
    top,
  };
}

export function placeComposerMentionMenu(input: {
  anchor: ComposerCaretAnchor;
  devicePixelRatio: number;
  menuHeight: number;
  menuWidth: number;
  viewportHeight: number;
  viewportWidth: number;
}): ComposerMentionMenuPlacement {
  const { anchor, devicePixelRatio, menuHeight, menuWidth, viewportHeight, viewportWidth } = input;
  const viewportPadding = 8;
  const anchorGap = 6;
  const width = Math.min(menuWidth, Math.max(0, viewportWidth - viewportPadding * 2));
  const availableAbove = Math.max(0, anchor.top - anchorGap - viewportPadding);
  const availableBelow = Math.max(0, viewportHeight - anchor.bottom - anchorGap - viewportPadding);
  const placement =
    availableAbove >= Math.min(menuHeight, 160) || availableAbove >= availableBelow
      ? "above"
      : "below";
  const availableHeight = placement === "above" ? availableAbove : availableBelow;
  const renderedHeight = Math.min(menuHeight, availableHeight);
  const rawTop =
    placement === "above" ? anchor.top - anchorGap - renderedHeight : anchor.bottom + anchorGap;
  const rawLeft = clamp(anchor.left, viewportPadding, viewportWidth - viewportPadding - width);

  return {
    left: roundToDevicePixel(rawLeft, devicePixelRatio),
    maxHeight: roundToDevicePixel(availableHeight, devicePixelRatio),
    placement,
    top: roundToDevicePixel(rawTop, devicePixelRatio),
  };
}
