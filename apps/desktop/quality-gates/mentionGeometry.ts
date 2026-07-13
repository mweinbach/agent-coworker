import { promises as fs } from "node:fs";

import { expect } from "@playwright/test";
import type { Page, TestInfo } from "playwright";

const PIXEL_CHANNEL_TOLERANCE = 8;
const MAX_DIFFERENT_PIXELS = 24;
const TEXTAREA_RANGE_MIRROR_PROPERTIES = [
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

type RectSnapshot = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

type HighlightGeometry = {
  end: number;
  maximumDelta: number | null;
  nativeRects: RectSnapshot[];
  overlayRects: RectSnapshot[];
  start: number;
};

export type IndependentMentionGeometry = {
  activeDescendant: string | null;
  caretMaximumDelta: number | null;
  caretInsideMenuWidth: boolean;
  highlightGeometry: HighlightGeometry[];
  highlightStyle: {
    backgroundColor: string;
    borderWidth: string;
    fontWeight: string;
    margin: string;
    padding: string;
  };
  maximumHighlightDelta: number | null;
  metricMismatches: string[];
  missingHighlightRanges: Array<{ end: number; start: number }>;
  nativeCaret: RectSnapshot | null;
  nativeMentionAdvance: number;
  overlayBoxMaximumDelta: number;
  overlayCaret: RectSnapshot | null;
  overlayScrollLeft: number;
  overlayScrollTop: number;
  pickerGap: number | null;
  scrollLeft: number;
  scrollTop: number;
  tolerance: number;
};

export type MentionPixelComparison = {
  channelTolerance: number;
  differentPixels: number;
  height: number;
  maximumChannelDelta: number;
  maximumDifferentPixels: number;
  ratio: number;
  width: number;
};

type MentionGeometryResult = {
  geometry: IndependentMentionGeometry;
  pixels: MentionPixelComparison;
};

function artifactSlug(value: string): string {
  return value.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "");
}

/**
 * Builds a test-owned Range mirror from only the native textarea's value,
 * client box, scroll offsets, and computed typography. Product overlay ranges
 * are measured separately, so shared overlay drift cannot move the reference.
 */
export async function measureIndependentMentionGeometry(
  page: Page,
  mentionText = "@geometry-audit",
): Promise<IndependentMentionGeometry> {
  return await page.locator('[role="combobox"][aria-label="Message input"]').evaluate(
    (element, fixture) => {
      if (!(element instanceof HTMLTextAreaElement)) {
        throw new Error("Message input is not a textarea");
      }
      const { mentionText: expectedMention, textGeometryProperties } = fixture;
      const textarea = element;
      const overlay = textarea.parentElement?.querySelector<HTMLDivElement>(
        '[data-slot="composer-highlight-overlay"]',
      );
      const menu = document.querySelector<HTMLElement>('[data-slot="composer-mention-menu"]');
      if (!overlay || !menu) {
        throw new Error("Mention geometry surface is incomplete");
      }

      const rectSnapshot = (rect: DOMRect): RectSnapshot => ({
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      });
      const rangeRects = (range: Range): RectSnapshot[] => {
        const rects = Array.from(range.getClientRects(), rectSnapshot);
        if (rects.length > 0) return rects;
        const rect = range.getBoundingClientRect();
        return rect.width !== 0 || rect.height !== 0 ? [rectSnapshot(rect)] : [];
      };
      const maximumRectDelta = (
        leftRects: RectSnapshot[],
        rightRects: RectSnapshot[],
      ): number | null => {
        if (leftRects.length !== rightRects.length || leftRects.length === 0) return null;
        let maximum = 0;
        for (let index = 0; index < leftRects.length; index += 1) {
          const left = leftRects[index];
          const right = rightRects[index];
          if (!left || !right) return null;
          maximum = Math.max(
            maximum,
            Math.abs(left.left - right.left),
            Math.abs(left.top - right.top),
            Math.abs(left.right - right.right),
            Math.abs(left.bottom - right.bottom),
            Math.abs(left.width - right.width),
            Math.abs(left.height - right.height),
          );
        }
        return maximum;
      };
      const findOverlayRange = (start: number, end: number): Range | null => {
        const walker = document.createTreeWalker(overlay, NodeFilter.SHOW_TEXT);
        let consumed = 0;
        let startNode: Text | null = null;
        let startOffset = 0;
        let endNode: Text | null = null;
        let endOffset = 0;
        let node = walker.nextNode();
        while (node) {
          const textNode = node as Text;
          const length = textNode.data.length;
          if (!startNode && start <= consumed + length) {
            startNode = textNode;
            startOffset = start - consumed;
          }
          if (end <= consumed + length) {
            endNode = textNode;
            endOffset = end - consumed;
            break;
          }
          consumed += length;
          node = walker.nextNode();
        }
        if (!startNode || !endNode) return null;
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        return range;
      };

      const textareaStyle = getComputedStyle(textarea);
      const overlayStyle = getComputedStyle(overlay);
      const textareaRect = textarea.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      const nativeMirror = document.createElement("div");
      nativeMirror.dataset.qualityNativeTextareaMirror = "true";
      nativeMirror.setAttribute("aria-hidden", "true");
      nativeMirror.style.position = "fixed";
      nativeMirror.style.pointerEvents = "none";
      nativeMirror.style.opacity = "0";
      nativeMirror.style.overflow = "hidden";
      nativeMirror.style.boxSizing = "border-box";
      nativeMirror.style.left = `${textareaRect.left + textarea.clientLeft}px`;
      nativeMirror.style.top = `${textareaRect.top + textarea.clientTop}px`;
      nativeMirror.style.width = `${textarea.clientWidth}px`;
      nativeMirror.style.height = `${textarea.clientHeight}px`;
      for (const property of textGeometryProperties) {
        nativeMirror.style.setProperty(property, textareaStyle.getPropertyValue(property));
      }
      const nativeText = document.createTextNode(`${textarea.value}\n`);
      nativeMirror.append(nativeText);
      document.body.append(nativeMirror);
      nativeMirror.scrollLeft = textarea.scrollLeft;
      nativeMirror.scrollTop = textarea.scrollTop;

      try {
        const mentionRanges: Array<{ end: number; start: number }> = [];
        let mentionIndex = textarea.value.indexOf(expectedMention);
        while (mentionIndex >= 0) {
          mentionRanges.push({
            end: mentionIndex + expectedMention.length,
            start: mentionIndex,
          });
          mentionIndex = textarea.value.indexOf(
            expectedMention,
            mentionIndex + expectedMention.length,
          );
        }
        if (mentionRanges.length === 0) {
          throw new Error(`Textarea does not contain the expected mention: ${expectedMention}`);
        }

        const missingHighlightRanges: Array<{ end: number; start: number }> = [];
        const highlightGeometry = mentionRanges.map(({ end, start }) => {
          const nativeRange = document.createRange();
          nativeRange.setStart(nativeText, start);
          nativeRange.setEnd(nativeText, end);
          const nativeRects = rangeRects(nativeRange);
          const highlight = overlay.querySelector<HTMLElement>(
            `[data-mention-start="${start}"][data-mention-end="${end}"]`,
          );
          const overlayRects = highlight
            ? Array.from(highlight.getClientRects(), rectSnapshot)
            : [];
          if (!highlight) missingHighlightRanges.push({ end, start });
          return {
            end,
            maximumDelta: maximumRectDelta(nativeRects, overlayRects),
            nativeRects,
            overlayRects,
            start,
          };
        });

        const caret = textarea.selectionStart ?? textarea.value.length;
        const nativeCaretRange = document.createRange();
        nativeCaretRange.setStart(nativeText, caret);
        nativeCaretRange.collapse(true);
        const nativeCaret = rangeRects(nativeCaretRange)[0] ?? null;
        const overlayCaretRange = findOverlayRange(caret, caret);
        const overlayCaret = overlayCaretRange ? (rangeRects(overlayCaretRange)[0] ?? null) : null;
        const menuRect = menu.getBoundingClientRect();
        const menuHorizontalTolerance = 0.5 / window.devicePixelRatio + 0.01;
        const placement = menu.dataset.placement;
        const pickerGap =
          nativeCaret === null
            ? null
            : placement === "above"
              ? nativeCaret.top - menuRect.bottom
              : menuRect.top - nativeCaret.bottom;
        const metricMismatches = textGeometryProperties.filter(
          (property) =>
            textareaStyle.getPropertyValue(property) !== overlayStyle.getPropertyValue(property),
        );
        const firstHighlight = overlay.querySelector<HTMLElement>("[data-mention-start]");
        if (!firstHighlight) throw new Error("Mention highlight is missing");
        const highlightStyle = getComputedStyle(firstHighlight);
        const highlightDeltas = highlightGeometry
          .map((entry) => entry.maximumDelta)
          .filter((value): value is number => value !== null);

        return {
          activeDescendant: textarea.getAttribute("aria-activedescendant"),
          caretMaximumDelta:
            nativeCaret && overlayCaret ? maximumRectDelta([nativeCaret], [overlayCaret]) : null,
          caretInsideMenuWidth:
            nativeCaret !== null &&
            nativeCaret.left >= menuRect.left - menuHorizontalTolerance &&
            nativeCaret.left <= menuRect.right + menuHorizontalTolerance,
          highlightGeometry,
          highlightStyle: {
            backgroundColor: highlightStyle.backgroundColor,
            borderWidth: highlightStyle.borderWidth,
            fontWeight: highlightStyle.fontWeight,
            margin: highlightStyle.margin,
            padding: highlightStyle.padding,
          },
          maximumHighlightDelta: highlightDeltas.length > 0 ? Math.max(...highlightDeltas) : null,
          metricMismatches,
          missingHighlightRanges,
          nativeCaret,
          nativeMentionAdvance:
            highlightGeometry.at(-1)?.nativeRects.reduce((sum, rect) => sum + rect.width, 0) ?? 0,
          overlayBoxMaximumDelta: Math.max(
            Math.abs(overlayRect.left - (textareaRect.left + textarea.clientLeft)),
            Math.abs(overlayRect.top - (textareaRect.top + textarea.clientTop)),
            Math.abs(overlayRect.width - textarea.clientWidth),
            Math.abs(overlayRect.height - textarea.clientHeight),
          ),
          overlayCaret,
          overlayScrollLeft: overlay.scrollLeft,
          overlayScrollTop: overlay.scrollTop,
          pickerGap,
          scrollLeft: textarea.scrollLeft,
          scrollTop: textarea.scrollTop,
          tolerance: 1 / window.devicePixelRatio + 0.01,
        };
      } finally {
        nativeMirror.remove();
      }
    },
    {
      mentionText,
      textGeometryProperties: TEXTAREA_RANGE_MIRROR_PROPERTIES,
    },
  );
}

async function captureMentionPixelComparison(
  page: Page,
  testInfo: TestInfo,
  attachmentName: string,
  mentionText: string,
): Promise<MentionPixelComparison> {
  // Compare the shipped overlay with a separately rendered textarea reference.
  // Both captures keep the native textarea glyphs, so only highlight paint can differ.
  const composer = page.locator('[role="combobox"][aria-label="Message input"]');
  const clip = await composer.boundingBox();
  if (!clip) throw new Error("Message input has no screenshot bounds");
  const screenshotOptions = {
    animations: "disabled",
    caret: "hide",
    clip,
    scale: "css",
  } as const;
  const actual = await page.screenshot(screenshotOptions);

  await composer.evaluate(
    (element, fixture) => {
      if (!(element instanceof HTMLTextAreaElement)) {
        throw new Error("Message input is not a textarea");
      }
      const { mentionText: expectedMention, textGeometryProperties } = fixture;
      const textarea = element;
      const parent = textarea.parentElement;
      const overlay = parent?.querySelector<HTMLDivElement>(
        '[data-slot="composer-highlight-overlay"]',
      );
      const sourceHighlight = overlay?.querySelector<HTMLElement>("[data-mention-start]");
      if (!parent || !overlay || !sourceHighlight) {
        throw new Error("Mention pixel reference surface is incomplete");
      }

      const textareaStyle = getComputedStyle(textarea);
      const highlightStyle = getComputedStyle(sourceHighlight);
      const reference = document.createElement("div");
      reference.dataset.qualityNativeTextareaReference = "true";
      reference.setAttribute("aria-hidden", "true");
      reference.style.position = "absolute";
      reference.style.pointerEvents = "none";
      reference.style.userSelect = "none";
      reference.style.overflow = "hidden";
      reference.style.boxSizing = "border-box";
      reference.style.color = "transparent";
      reference.style.left = `${textarea.offsetLeft + textarea.clientLeft}px`;
      reference.style.top = `${textarea.offsetTop + textarea.clientTop}px`;
      reference.style.width = `${textarea.clientWidth}px`;
      reference.style.height = `${textarea.clientHeight}px`;
      for (const property of textGeometryProperties) {
        reference.style.setProperty(property, textareaStyle.getPropertyValue(property));
      }

      let consumed = 0;
      let mentionIndex = textarea.value.indexOf(expectedMention);
      while (mentionIndex >= 0) {
        reference.append(document.createTextNode(textarea.value.slice(consumed, mentionIndex)));
        const mention = document.createElement("span");
        mention.textContent = expectedMention;
        mention.style.color = "transparent";
        mention.style.backgroundColor = highlightStyle.backgroundColor;
        mention.style.backgroundImage = highlightStyle.backgroundImage;
        mention.style.borderRadius = highlightStyle.borderRadius;
        mention.style.boxShadow = highlightStyle.boxShadow;
        reference.append(mention);
        consumed = mentionIndex + expectedMention.length;
        mentionIndex = textarea.value.indexOf(expectedMention, consumed);
      }
      reference.append(document.createTextNode(`${textarea.value.slice(consumed)}\n`));
      overlay.dataset.qualityPreviousVisibility = overlay.style.visibility;
      overlay.style.visibility = "hidden";
      parent.append(reference);
      reference.scrollLeft = textarea.scrollLeft;
      reference.scrollTop = textarea.scrollTop;
    },
    {
      mentionText,
      textGeometryProperties: TEXTAREA_RANGE_MIRROR_PROPERTIES,
    },
  );

  let reference: Buffer;
  try {
    reference = await page.screenshot(screenshotOptions);
  } finally {
    await composer.evaluate((element) => {
      if (!(element instanceof HTMLTextAreaElement)) return;
      const parent = element.parentElement;
      const overlay = parent?.querySelector<HTMLDivElement>(
        '[data-slot="composer-highlight-overlay"]',
      );
      parent?.querySelector('[data-quality-native-textarea-reference="true"]')?.remove();
      if (!overlay) return;
      overlay.style.visibility = overlay.dataset.qualityPreviousVisibility ?? "";
      delete overlay.dataset.qualityPreviousVisibility;
    });
  }

  const comparison = await page.evaluate(
    async ({ actualBase64, channelTolerance, maximumDifferentPixels, referenceBase64 }) => {
      const decode = async (base64: string): Promise<ImageBitmap> => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      };
      const actualImage = await decode(actualBase64);
      const referenceImage = await decode(referenceBase64);
      if (
        actualImage.width !== referenceImage.width ||
        actualImage.height !== referenceImage.height
      ) {
        throw new Error(
          `Mention pixel images have different dimensions: ${actualImage.width}x${actualImage.height} and ${referenceImage.width}x${referenceImage.height}`,
        );
      }
      const width = actualImage.width;
      const height = actualImage.height;
      const actualCanvas = document.createElement("canvas");
      const referenceCanvas = document.createElement("canvas");
      const diffCanvas = document.createElement("canvas");
      for (const canvas of [actualCanvas, referenceCanvas, diffCanvas]) {
        canvas.width = width;
        canvas.height = height;
      }
      const actualContext = actualCanvas.getContext("2d", { willReadFrequently: true });
      const referenceContext = referenceCanvas.getContext("2d", { willReadFrequently: true });
      const diffContext = diffCanvas.getContext("2d");
      if (!actualContext || !referenceContext || !diffContext) {
        throw new Error("Canvas 2D context is unavailable");
      }
      actualContext.drawImage(actualImage, 0, 0);
      referenceContext.drawImage(referenceImage, 0, 0);
      const actualPixels = actualContext.getImageData(0, 0, width, height).data;
      const referencePixels = referenceContext.getImageData(0, 0, width, height).data;
      const diffImage = diffContext.createImageData(width, height);
      let differentPixels = 0;
      let maximumChannelDelta = 0;
      for (let offset = 0; offset < actualPixels.length; offset += 4) {
        const redDelta = Math.abs((actualPixels[offset] ?? 0) - (referencePixels[offset] ?? 0));
        const greenDelta = Math.abs(
          (actualPixels[offset + 1] ?? 0) - (referencePixels[offset + 1] ?? 0),
        );
        const blueDelta = Math.abs(
          (actualPixels[offset + 2] ?? 0) - (referencePixels[offset + 2] ?? 0),
        );
        const alphaDelta = Math.abs(
          (actualPixels[offset + 3] ?? 0) - (referencePixels[offset + 3] ?? 0),
        );
        const pixelDelta = Math.max(redDelta, greenDelta, blueDelta, alphaDelta);
        maximumChannelDelta = Math.max(maximumChannelDelta, pixelDelta);
        if (pixelDelta <= channelTolerance) continue;
        differentPixels += 1;
        diffImage.data[offset] = 255;
        diffImage.data[offset + 1] = 0;
        diffImage.data[offset + 2] = 255;
        diffImage.data[offset + 3] = 255;
      }
      diffContext.putImageData(diffImage, 0, 0);
      const diffBase64 = diffCanvas.toDataURL("image/png").split(",", 2)[1] ?? "";
      actualImage.close();
      referenceImage.close();
      return {
        comparison: {
          channelTolerance,
          differentPixels,
          height,
          maximumChannelDelta,
          maximumDifferentPixels,
          ratio: differentPixels / (width * height),
          width,
        },
        diffBase64,
      };
    },
    {
      actualBase64: actual.toString("base64"),
      channelTolerance: PIXEL_CHANNEL_TOLERANCE,
      maximumDifferentPixels: MAX_DIFFERENT_PIXELS,
      referenceBase64: reference.toString("base64"),
    },
  );

  const slug = artifactSlug(attachmentName);
  const actualPath = testInfo.outputPath(`${slug}-actual.png`);
  const referencePath = testInfo.outputPath(`${slug}-reference.png`);
  const diffPath = testInfo.outputPath(`${slug}-diff.png`);
  await Promise.all([
    fs.writeFile(actualPath, actual),
    fs.writeFile(referencePath, reference),
    fs.writeFile(diffPath, Buffer.from(comparison.diffBase64, "base64")),
  ]);
  await Promise.all([
    testInfo.attach(`${attachmentName}-actual`, { path: actualPath }),
    testInfo.attach(`${attachmentName}-reference`, { path: referencePath }),
    testInfo.attach(`${attachmentName}-diff`, { path: diffPath }),
  ]);
  return comparison.comparison;
}

export async function assertIndependentMentionGeometry(
  page: Page,
  testInfo: TestInfo,
  options: { attachmentName: string; mentionText?: string },
): Promise<MentionGeometryResult> {
  const mentionText = options.mentionText ?? "@geometry-audit";
  const geometry = await measureIndependentMentionGeometry(page, mentionText);
  const pixels = await captureMentionPixelComparison(
    page,
    testInfo,
    options.attachmentName,
    mentionText,
  );
  const metricsPath = testInfo.outputPath(`${artifactSlug(options.attachmentName)}-metrics.json`);
  await fs.writeFile(metricsPath, `${JSON.stringify({ geometry, pixels }, null, 2)}\n`, "utf8");
  await testInfo.attach(`${options.attachmentName}-metrics`, { path: metricsPath });

  const failures: string[] = [];
  if (geometry.metricMismatches.length > 0) {
    failures.push(`metric mismatches: ${geometry.metricMismatches.join(", ")}`);
  }
  if (geometry.missingHighlightRanges.length > 0) {
    failures.push(`missing highlight ranges: ${JSON.stringify(geometry.missingHighlightRanges)}`);
  }
  if (geometry.caretMaximumDelta === null || geometry.caretMaximumDelta > geometry.tolerance) {
    failures.push(
      `caret delta ${geometry.caretMaximumDelta ?? "unmeasurable"} > ${geometry.tolerance}`,
    );
  }
  if (
    geometry.maximumHighlightDelta === null ||
    geometry.maximumHighlightDelta > geometry.tolerance
  ) {
    failures.push(
      `highlight delta ${geometry.maximumHighlightDelta ?? "unmeasurable"} > ${geometry.tolerance}`,
    );
  }
  if (geometry.overlayBoxMaximumDelta > geometry.tolerance) {
    failures.push(`overlay box delta ${geometry.overlayBoxMaximumDelta} > ${geometry.tolerance}`);
  }
  if (pixels.differentPixels > pixels.maximumDifferentPixels) {
    failures.push(
      `pixel mismatch ${pixels.differentPixels} > ${pixels.maximumDifferentPixels} (channel tolerance ${pixels.channelTolerance})`,
    );
  }
  expect(
    failures,
    `Independent mention geometry drift: caret=${geometry.caretMaximumDelta ?? "unmeasurable"}, highlight=${geometry.maximumHighlightDelta ?? "unmeasurable"}, pixels=${pixels.differentPixels}`,
  ).toEqual([]);
  return { geometry, pixels };
}
