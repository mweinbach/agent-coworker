import { describe, expect, mock, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { createEmptyComposerDraft } from "../src/app/composerDrafts";
import type { ComposerSubmission } from "../src/app/composerSubmission";
import {
  type MessageComposerAttachmentItem,
  MessageComposerAttachments,
  MessageComposerBody,
  MessageComposerFooter,
  MessageComposerForm,
  MessageComposerRoot,
  MessageComposerStatus,
  MessageComposerStop,
  MessageComposerSubmissionNotice,
  MessageComposerSubmit,
  MessageComposerTextarea,
  MessageComposerTools,
} from "../src/ui/composer/MessageComposer";
import { setupJsdom } from "./jsdomHarness";

const IMAGE_ATTACHMENT: MessageComposerAttachmentItem = {
  filename: "diagram.png",
  mimeType: "image/png",
  previewUrl: "blob:diagram-preview",
};
const ACCEPTED_SUBMISSION: ComposerSubmission = {
  id: "submission-1",
  clientMessageId: "client-message-1",
  owner: { key: "thread:thread-1", revision: 1, submissionId: "submission-1" },
  request: { kind: "thread", threadId: "thread-1" },
  draft: { ...createEmptyComposerDraft(), revision: 1, text: "Tighten the answer" },
  prepared: { text: "Tighten the answer", attachments: undefined },
  phase: "accepted",
  delivery: "steer",
  error: null,
};

function AttachmentHarness({ onRemove }: { onRemove: (index: number) => void }) {
  const [attachments, setAttachments] = useState<readonly MessageComposerAttachmentItem[]>([
    IMAGE_ATTACHMENT,
  ]);

  return createElement(MessageComposerAttachments, {
    attachments,
    onRemove: (index) => {
      onRemove(index);
      setAttachments((current) => current.filter((_, currentIndex) => currentIndex !== index));
    },
  });
}

describe("message composer", () => {
  test("renders every shared composer surface with renamed data slots", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageComposerRoot,
        null,
        createElement(
          MessageComposerForm,
          null,
          createElement(MessageComposerStatus, null, "Ready"),
          createElement(
            MessageComposerBody,
            null,
            createElement(MessageComposerTextarea, { "aria-label": "Draft" }),
          ),
          createElement(
            MessageComposerFooter,
            null,
            createElement(MessageComposerTools, null, "Tools"),
            createElement(MessageComposerSubmit, { status: "ready" }),
          ),
        ),
      ),
    );

    expect(html).toContain('data-slot="message-composer"');
    expect(html).toContain('data-slot="message-composer-status"');
    expect(html).toContain('aria-label="Draft"');
    expect(html).toContain('aria-label="Send message"');
  });

  test("renders shadcn attachment parts and removes an attachment", async () => {
    const harness = setupJsdom();
    const onRemove = mock((_index: number) => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(AttachmentHarness, { onRemove }));
      });

      expect(container.querySelector('[data-slot="attachment-group"]')).not.toBeNull();
      expect(container.querySelector('[data-slot="attachment"]')).not.toBeNull();
      expect(container.querySelector('[data-slot="attachment-media"] img')).not.toBeNull();
      expect(container.textContent).toContain("diagram.png");
      expect(container.textContent).toContain("IMAGE");

      const removeButton = container.querySelector(
        '[aria-label="Remove diagram.png"]',
      ) as HTMLButtonElement | null;
      if (!removeButton) throw new Error("missing attachment remove button");

      await act(async () => {
        removeButton.click();
      });

      expect(onRemove).toHaveBeenCalledWith(0);
      expect(container.querySelector('[data-slot="attachment"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("preserves drag-and-drop file ingestion", async () => {
    const harness = setupJsdom();
    const onFiles = mock(async (_files: File[]) => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            MessageComposerRoot,
            { fileDrop: { onFiles } },
            createElement(MessageComposerTextarea, { "aria-label": "Draft" }),
          ),
        );
      });

      const composer = container.querySelector(
        '[data-slot="message-composer"]',
      ) as HTMLFieldSetElement | null;
      if (!composer) throw new Error("missing composer");
      const file = new harness.dom.window.File(["hello"], "notes.txt", { type: "text/plain" });
      const dataTransfer = {
        files: [file],
        types: ["Files"],
        dropEffect: "none",
      };

      const dragEnter = new harness.dom.window.Event("dragenter", { bubbles: true });
      Object.defineProperty(dragEnter, "dataTransfer", { value: dataTransfer });
      await act(async () => {
        composer.dispatchEvent(dragEnter);
      });
      expect(composer.hasAttribute("data-file-drag-active")).toBe(true);
      expect(container.querySelector('[role="status"]')?.textContent).toContain("File drop ready");

      const drop = new harness.dom.window.Event("drop", { bubbles: true });
      Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
      await act(async () => {
        composer.dispatchEvent(drop);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onFiles).toHaveBeenCalledTimes(1);
      expect(onFiles.mock.calls[0]?.[0]?.[0]?.name).toBe("notes.txt");
      expect(composer.hasAttribute("data-file-drag-active")).toBe(false);
      expect(container.querySelector('[role="status"]')?.textContent).toContain("1 file attached");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("announces file-drop failures as actionable alerts", async () => {
    const harness = setupJsdom();
    const onFiles = mock(async (_files: File[]) => {
      throw new Error("Unsupported file");
    });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);
      await act(async () => {
        root.render(
          createElement(
            MessageComposerRoot,
            { fileDrop: { onFiles } },
            createElement(MessageComposerTextarea, { "aria-label": "Draft" }),
          ),
        );
      });

      const composer = container.querySelector(
        '[data-slot="message-composer"]',
      ) as HTMLFieldSetElement | null;
      if (!composer) throw new Error("missing composer");
      const file = new harness.dom.window.File(["bad"], "bad.bin");
      const drop = new harness.dom.window.Event("drop", { bubbles: true });
      Object.defineProperty(drop, "dataTransfer", {
        value: { files: [file], types: ["Files"], dropEffect: "none" },
      });
      await act(async () => {
        composer.dispatchEvent(drop);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not attach 1 file. Unsupported file",
      );
      await act(async () => root.unmount());
    } finally {
      harness.restore();
    }
  });

  test("preserves send, steer, pending, and stop controls", () => {
    const send = renderToStaticMarkup(createElement(MessageComposerSubmit, { status: "ready" }));
    const steer = renderToStaticMarkup(
      createElement(MessageComposerSubmit, { status: "ready", mode: "steer-ready" }),
    );
    const pending = renderToStaticMarkup(
      createElement(MessageComposerSubmit, { status: "pending" }),
    );
    const pendingSteer = renderToStaticMarkup(
      createElement(MessageComposerSubmit, { status: "pending", mode: "steer-pending" }),
    );
    const stop = renderToStaticMarkup(createElement(MessageComposerStop, { onStop: () => {} }));
    const stopping = renderToStaticMarkup(
      createElement(MessageComposerStop, { pending: true, onStop: () => {} }),
    );

    expect(send).toContain('aria-label="Send message"');
    expect(send).toContain('type="submit"');
    expect(steer).toContain('aria-label="Send guidance to current response"');
    expect(pending).toContain('aria-label="Sending message"');
    expect(pendingSteer).toContain('aria-label="Sending guidance to current response"');
    expect(stop).toContain('aria-label="Stop current response"');
    expect(stop).toContain('type="button"');
    expect(stop).toContain("bg-destructive");
    expect(stopping).toContain('aria-label="Stopping current response"');
    expect(stopping).toContain('aria-busy="true"');
  });

  test("keeps accepted guidance status clear without offering an unsafe edit", () => {
    const editable = renderToStaticMarkup(
      createElement(MessageComposerSubmissionNotice, {
        submission: ACCEPTED_SUBMISSION,
        onRetry: () => {},
        onEdit: () => {},
        onDismiss: () => {},
      }),
    );
    const protectedDraft = renderToStaticMarkup(
      createElement(MessageComposerSubmissionNotice, {
        submission: ACCEPTED_SUBMISSION,
        onRetry: () => {},
        onEdit: () => {},
        canEditAccepted: false,
        onDismiss: () => {},
      }),
    );

    expect(editable).toContain("Guidance accepted. Restore it to edit and send as a follow-up.");
    expect(editable).toContain("Edit as follow-up");
    expect(protectedDraft).toContain("Guidance accepted. Your newer draft stays unchanged.");
    expect(protectedDraft).not.toContain("Edit as follow-up");
    expect(protectedDraft).toContain('role="status"');
    expect(protectedDraft).toContain('aria-live="polite"');
  });
});
