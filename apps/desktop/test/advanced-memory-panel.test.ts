import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { AdvancedMemoryEditorDialog, AdvancedMemoryPanel } = await import(
  "../src/ui/settings/pages/AdvancedMemoryPanel"
);
const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const { operationKey } = await import("../src/app/store.helpers");

function buttonWithText(scope: ParentNode, label: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function changeField(document: Document, id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!input) throw new Error(`Missing field: ${id}`);
  input.value = value;
  // React loads before jsdom in the Bun preload; invoke the rendered field's
  // actual change handler, as in the other settings-page tests.
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`Missing React props: ${id}`);
  const props = (input as unknown as Record<string, unknown>)[propsKey] as {
    onChange: (event: { target: typeof input; currentTarget: typeof input }) => void;
  };
  props.onChange({ target: input, currentTarget: input });
}

describe("advanced memory panel", () => {
  test.each(["create", "edit"] as const)(
    "%s keeps the real draft and identity through failure, pending save, and retry",
    async (mode) => {
      const previousState = useAppStore.getState();
      const harness = setupJsdom();
      const document = harness.dom.window.document;
      const root = createRoot(document.getElementById("root")!);
      const workspaceId = "memory-editor-workspace";
      const cwd = "/tmp/shared-memory-target";
      const key = operationKey("memory", "advanced-save", workspaceId);
      const completion = Promise.withResolvers<{ ok: true; value: undefined }>();
      const save = mock<typeof previousState.upsertAdvancedMemory>(async () => {
        useAppStore.setState({
          operationsByKey: {
            [key]: {
              status: "pending",
              key,
              label: "Save memory",
              startedAt: "2026-08-27T00:00:00.000Z",
              error: null,
            },
          },
        });
        const result = await completion.promise;
        useAppStore.setState({ operationsByKey: {} });
        return result;
      }).mockResolvedValueOnce({
        ok: false,
        error: { code: "request_failed", message: "Read-only memory", retryable: true },
      });
      const request = mock(async () => {});

      try {
        useAppStore.setState({
          operationsByKey: {},
          requestAdvancedMemories: request,
          upsertAdvancedMemory: save,
          workspaceRuntimeById: {
            [workspaceId]: {
              ...defaultWorkspaceRuntime(),
              controlSessionId: "memory-control-session",
              advancedMemoryActiveFolder: "shared-folder",
              advancedMemories: [
                {
                  slug: "original-memory-id",
                  name: "Original name",
                  description: "Original description",
                  type: "feedback",
                  body: "Original body",
                  updatedAt: "2026-08-27T00:00:00.000Z",
                },
              ],
            },
          },
        });
        await act(async () =>
          root.render(createElement(AdvancedMemoryPanel, { workspaceId, cwd })),
        );
        expect(request).toHaveBeenCalledWith(workspaceId, { cwd });

        if (mode === "edit") {
          await act(async () => {
            const row = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
              button.textContent?.includes("Original name"),
            );
            if (!row) throw new Error("Missing memory row");
            row.click();
          });
          await act(async () => buttonWithText(document, "Edit").click());
        } else {
          await act(async () => buttonWithText(document, "Add memory").click());
        }

        await act(async () => {
          changeField(document, "adv-memory-name", "  Renamed memory  ");
          changeField(document, "adv-memory-desc", "  Updated description  ");
          changeField(document, "adv-memory-body", "  Updated body\n  ");
        });
        const dialog = document.querySelector('[role="dialog"]')!;
        const submit = buttonWithText(dialog, mode === "edit" ? "Save changes" : "Add memory");
        await act(async () => submit.click());
        const expectedInput = {
          folder: "shared-folder",
          ...(mode === "edit" ? { slug: "original-memory-id" } : {}),
          name: "Renamed memory",
          description: "Updated description",
          type: mode === "edit" ? "feedback" : "note",
          body: "Updated body",
        };
        expect(save).toHaveBeenCalledWith(workspaceId, expectedInput, { cwd });
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        expect((document.getElementById("adv-memory-name") as HTMLInputElement).value).toBe(
          "  Renamed memory  ",
        );
        expect(submit.disabled).toBe(false);

        await act(async () => submit.click());
        expect(submit.disabled).toBe(true);
        expect(submit.textContent).toBe("Saving…");
        expect((document.getElementById("adv-memory-body") as HTMLTextAreaElement).disabled).toBe(
          true,
        );
        await act(async () => submit.click());
        expect(save).toHaveBeenCalledTimes(2);

        await act(async () => completion.resolve({ ok: true, value: undefined }));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        await act(async () => buttonWithText(document, "Add memory").click());
        expect((document.getElementById("adv-memory-name") as HTMLInputElement).value).toBe("");
        expect((document.getElementById("adv-memory-body") as HTMLTextAreaElement).value).toBe("");
        await act(async () => {
          changeField(document, "adv-memory-name", "Fresh memory");
          changeField(document, "adv-memory-body", "Fresh body");
        });
        await act(async () =>
          buttonWithText(document.querySelector('[role="dialog"]')!, "Add memory").click(),
        );
        expect(save.mock.calls.at(-1)).toEqual([
          workspaceId,
          {
            folder: "shared-folder",
            name: "Fresh memory",
            description: "",
            type: "note",
            body: "Fresh body",
          },
          { cwd },
        ]);
      } finally {
        completion.resolve({ ok: true, value: undefined });
        await act(async () => root.unmount());
        useAppStore.setState(previousState, true);
        harness.restore();
      }
    },
  );

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
