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
            operation: undefined,
            isDirty: true,
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

  test("failed saves keep the draft editable beside an assertive error", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(AdvancedMemoryEditorDialog, {
            open: true,
            editingSlug: null,
            draft: {
              slug: "",
              name: "Retained name",
              description: "Retained description",
              type: "feedback",
              body: "Retained body",
            },
            saving: false,
            operation: {
              status: "error",
              key: "memory:advanced-save:workspace",
              label: "Save advanced memory",
              startedAt: "2026-07-11T00:00:00.000Z",
              finishedAt: "2026-07-11T00:00:01.000Z",
              error: {
                code: "request_failed",
                message: "Memory file is read-only.",
                retryable: true,
                repairAction: "Review the memory fields and retry.",
              },
            },
            isDirty: true,
            setDraft: mock(() => {}),
            onCancel: mock(() => {}),
            onSave: mock(() => {}),
          }),
        );
      });

      const name = harness.dom.window.document.getElementById("adv-memory-name");
      const body = harness.dom.window.document.getElementById("adv-memory-body");
      const failure = harness.dom.window.document.querySelector('[data-slot="alert"]');
      expect(name).toBeInstanceOf(harness.dom.window.HTMLInputElement);
      expect(body).toBeInstanceOf(harness.dom.window.HTMLTextAreaElement);
      expect((name as HTMLInputElement).value).toBe("Retained name");
      expect((body as HTMLTextAreaElement).value).toBe("Retained body");
      expect((name as HTMLInputElement).disabled).toBe(false);
      expect((body as HTMLTextAreaElement).disabled).toBe(false);
      expect(failure?.getAttribute("aria-live")).toBe("assertive");
      expect(failure?.textContent).toContain("Memory file is read-only.");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
