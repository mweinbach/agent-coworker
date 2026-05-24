import { describe, expect, test } from "bun:test";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { useAppStore } = await import("../src/app/store");
const { ChatComposer } = await import("../src/ui/chat/ChatComposer");

function renderComposer() {
  return createElement(ChatComposer, {
    messageBarOverlayRef: createRef<HTMLDivElement>(),
    composerOverlayMinHeight: 120,
    messageBarHeight: 96,
    inputDisabled: false,
    transcriptOnly: false,
    ingestAttachmentFiles: () => {},
    isUploading: false,
    uploadProgress: 0,
    pendingAttachments: [],
    removeAttachment: () => {},
    submitComposer: () => {},
    busy: false,
    composerHint: null,
    composerSubmitState: { mode: "send", status: "ready", disabled: false },
    attachmentPickerError: null,
    composerText: "",
    setComposerText: () => {},
    onComposerKeyDown: () => {},
    placeholder: "Message",
    textareaRef: createRef<HTMLTextAreaElement>(),
    fileInputRef: createRef<HTMLInputElement>(),
    handleFileSelect: () => {},
    threadModelConfig: null,
    threadDraft: false,
    selectedThreadId: "thread-1",
    modelDisplayNames: {},
    preparingAttachments: false,
  });
}

describe("chat composer Liquid-DOM gate", () => {
  test("keeps the normal prompt surface when the setting is enabled but WebGPU is unavailable", async () => {
    const harness = setupJsdom({
      includeAnimationFrame: true,
    });
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          desktopSettings: {
            quickChat: {
              iconEnabled: true,
              shortcutEnabled: false,
              shortcutAccelerator: "CommandOrControl+Shift+Space",
            },
            liquidGlass: {
              composerEnabled: true,
            },
            archivedChatsAutoDeleteDays: 0,
            sidebarSectionOrder: ["projects", "chats"],
          },
        });
        root.render(renderComposer());
      });

      const promptInput = container.querySelector('[data-slot="prompt-input"]');
      expect(promptInput?.getAttribute("data-prompt-input-surface")).toBe("default");
      expect(promptInput?.getAttribute("data-liquid-dom-surface")).toBeNull();
      expect(container.querySelector("[data-liquid-dom-backdrop]")).toBeNull();
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });
});
