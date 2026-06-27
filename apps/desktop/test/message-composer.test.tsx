import { describe, expect, mock, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type MessageComposerAttachmentItem,
  MessageComposerAttachments,
  MessageComposerBody,
  MessageComposerFooter,
  MessageComposerForm,
  MessageComposerRoot,
  MessageComposerStatus,
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

      const drop = new harness.dom.window.Event("drop", { bubbles: true });
      Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
      await act(async () => {
        composer.dispatchEvent(drop);
        await Promise.resolve();
      });

      expect(onFiles).toHaveBeenCalledTimes(1);
      expect(onFiles.mock.calls[0]?.[0]?.[0]?.name).toBe("notes.txt");
      expect(composer.hasAttribute("data-file-drag-active")).toBe(false);

      await act(async () => {
        root.unmount();
      });
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
    const stop = renderToStaticMarkup(
      createElement(MessageComposerSubmit, { status: "streaming", onStop: () => {} }),
    );

    expect(send).toContain('aria-label="Send message"');
    expect(steer).toContain('aria-label="Steer current response"');
    expect(pending).toContain('aria-label="Sending message"');
    expect(stop).toContain('aria-label="Stop generating response"');
    expect(stop).toContain("bg-destructive");
  });
});
