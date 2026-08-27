import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CanvasFilePreviewLayout } from "../src/ui/canvas/CanvasFilePreviewLayout";

test.each([
  { label: "inline document", isCanvasMode: false, previewKind: "txt", isSpreadsheet: false },
  { label: "canvas document", isCanvasMode: true, previewKind: "txt", isSpreadsheet: false },
  { label: "inline spreadsheet", isCanvasMode: false, previewKind: "csv", isSpreadsheet: true },
  { label: "canvas spreadsheet", isCanvasMode: true, previewKind: "xlsx", isSpreadsheet: true },
])("preserves the $label surface", ({ isCanvasMode, previewKind, isSpreadsheet }) => {
  const html = renderToStaticMarkup(
    createElement(CanvasFilePreviewLayout, {
      isCanvasMode,
      isAgentBusy: false,
      fileName: `preview.${previewKind}`,
      previewKind,
      onClose: () => {},
      children: createElement("span", null, "Preview body"),
    }),
  );
  const classes = html.match(/^<div class="([^"]+)"/)?.[1]?.split(" ");
  expect(classes).toBeDefined();
  if (isCanvasMode || isSpreadsheet) {
    expect(classes).toContain("bg-canvas");
    expect(classes).toContain("text-canvas-foreground");
    expect(classes).not.toContain("bg-[var(--surface-sidebar-pane)]");
  } else {
    expect(classes).toContain("bg-[var(--surface-sidebar-pane)]");
    expect(classes).toContain("text-foreground");
    expect(classes).not.toContain("bg-canvas");
  }
  expect(classes?.includes("app-canvas-mode-window")).toBe(isCanvasMode);
  expect(html).toContain(`data-canvas-surface="${isSpreadsheet ? "spreadsheet" : "document"}"`);
  expect(html.includes("color-scheme:light")).toBe(isSpreadsheet);
  expect(html.includes('title="Close Window"')).toBe(isCanvasMode);
  expect(html).toContain("Preview body");
});
