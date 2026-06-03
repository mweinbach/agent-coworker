import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { AdvancedMemoryEditorDialog } = await import("../src/ui/settings/pages/AdvancedMemoryPanel");

describe("advanced memory panel", () => {
  test("edit memory dialog keeps long memories inside a bounded modal", async () => {
    const longBody = Array.from(
      { length: 40 },
      (_, index) => `Memory line ${index + 1}: important project context and source detail.`,
    ).join("\n");

    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(AdvancedMemoryEditorDialog, {
            open: true,
            editingSlug: "google-io",
            draft: {
              slug: "google-io",
              name: "Google I/O 2026 Workspace Analysis",
              description: "Long research workspace summary",
              type: "project",
              body: longBody,
            },
            saving: false,
            setDraft: mock(() => {}),
            onCancel: mock(() => {}),
            onSave: mock(() => {}),
          }),
        );
      });

      const dialogContent = harness.dom.window.document.querySelector(
        '[data-slot="dialog-content"]',
      );
      if (!(dialogContent instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing dialog content");
      }
      expect(dialogContent.className).toContain("max-h-[min(92vh,48rem)]");
      expect(dialogContent.className).toContain("w-[min(92vw,42rem)]");
      expect(dialogContent.className).toContain("overflow-hidden");

      const scrollRegion = dialogContent.querySelector(".overflow-y-auto");
      expect(scrollRegion?.className).toContain("min-h-0");
      expect(scrollRegion?.className).toContain("flex-1");

      const textarea = harness.dom.window.document.getElementById("adv-memory-body");
      if (!(textarea instanceof harness.dom.window.HTMLTextAreaElement)) {
        throw new Error("missing memory body textarea");
      }
      expect(textarea.className).toContain("[field-sizing:fixed]");
      expect(textarea.className).toContain("h-[min(42vh,24rem)]");
      expect(textarea.className).toContain("resize-y");
      expect(textarea.value).toBe(longBody);

      const footer = dialogContent.querySelector('[data-slot="dialog-footer"]');
      expect(footer?.className).toContain("shrink-0");
      expect(footer?.className).toContain("border-t");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
