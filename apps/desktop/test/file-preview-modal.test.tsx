import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

type PreviewResult = Awaited<ReturnType<typeof import("../src/lib/desktopCommands").readFileForPreview>>;

let previewResult: PreviewResult = {
  bytes: new Uint8Array(),
  byteLength: 0,
  truncated: false,
};

const readFileForPreviewMock = mock(async () => previewResult);
const getPreferredFileAppMock = mock(async (opts: { path: string }) => opts.path.endsWith(".docx") ? "Word" : null);
const loadDocxPreviewLayoutMock = mock(async () => ({
  accentColor: "#EC6210",
  titleColor: "#1C1B19",
  bodyColor: "#1C1B19",
  mutedColor: "#666666",
  dividerColor: "#FBBA13",
  fontFamily: "Aptos",
  headerImageSrc: "data:image/png;base64,ZmFrZQ==",
  headerImageWidthPx: 180,
  footerText: "Creative Strategies | Intel Pro Day 2026 work document",
}));

mock.module("mammoth", () => ({
  default: {
    convertToHtml: async () => ({ value: "<h1>Docx title</h1><p>Docx body</p>" }),
  },
}));

mock.module("dompurify", () => ({
  default: {
    sanitize: (value: string) => value,
  },
}));

mock.module("../src/lib/docxPreview", () => ({
  decorateDocxPreviewHtml: (value: string) => `<div class="docx-title">${value}</div>`,
  loadDocxPreviewLayout: loadDocxPreviewLayoutMock,
}));

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock({
  getPreferredFileApp: getPreferredFileAppMock,
  readFileForPreview: readFileForPreviewMock,
}));

const { useAppStore } = await import("../src/app/store");
const { FilePreviewModal } = await import("../src/ui/FilePreviewModal");

function resetAppStore() {
  const state = useAppStore.getState();
  useAppStore.setState({
    ...state,
    filePreview: null,
  } as any);
}

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("file preview modal", () => {
  beforeEach(() => {
    previewResult = {
      bytes: new Uint8Array(),
      byteLength: 0,
      truncated: false,
    };
    readFileForPreviewMock.mockClear();
    getPreferredFileAppMock.mockClear();
    loadDocxPreviewLayoutMock.mockClear();
    resetAppStore();
  });

  test.serial("shows the simplified header controls and a constrained markdown shell", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });

    try {
      const path = "/Users/mweinbach/Library/Mobile Documents/com~apple~CloudDocs/Claude/tmp/preview_latency_review.md";
      previewResult = {
        bytes: new TextEncoder().encode("# Preview latency review\n\nThis markdown body should render in a narrower reading column."),
        byteLength: 84,
        truncated: false,
      };

      useAppStore.setState({ filePreview: { path } });

      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(FilePreviewModal));
        await flushUi();
      });

      const doc = harness.dom.window.document;
      const markdownShell = doc.querySelector("[data-file-preview-markdown-shell='true']");

      expect(markdownShell?.className).toContain("max-w-[78ch]");
      expect(doc.body.textContent).toContain("Open");
      expect(doc.body.textContent).not.toContain(path);
      expect(doc.body.textContent).not.toContain("Copy path");
      expect(doc.body.textContent).not.toContain("Reveal");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("uses the preferred app label and renders the richer docx shell", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });

    try {
      const path = "/Users/mweinbach/Library/Mobile Documents/com~apple~CloudDocs/Claude/tmp/preview_latency_review.docx";
      previewResult = {
        bytes: new Uint8Array([1, 2, 3, 4]),
        byteLength: 4,
        truncated: false,
      };

      useAppStore.setState({ filePreview: { path } });

      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(FilePreviewModal));
        await flushUi();
        await flushUi();
      });

      const doc = harness.dom.window.document;
      const footer = doc.querySelector("[data-file-preview-docx-footer='true']");
      const headerImage = doc.querySelector("img[alt='Document header']");
      const docxShell = doc.querySelector(".docx-preview");

      expect(doc.body.textContent).toContain("Open in Word");
      expect(doc.body.textContent).toContain("Docx title");
      expect(footer?.textContent).toContain("Creative Strategies");
      expect(headerImage).not.toBeNull();
      expect(docxShell?.className).toContain("bg-white");
      expect(loadDocxPreviewLayoutMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("keeps clicks inside the popup open and closes on overlay clicks", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });

    try {
      const path = "/Users/mweinbach/Library/Mobile Documents/com~apple~CloudDocs/Claude/tmp/preview_latency_review.docx";
      previewResult = {
        bytes: new Uint8Array([1, 2, 3, 4]),
        byteLength: 4,
        truncated: false,
      };

      useAppStore.setState({ filePreview: { path } });

      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(FilePreviewModal));
        await flushUi();
        await flushUi();
      });

      const dialog = harness.dom.window.document.querySelector("[data-slot='dialog-content']");
      const overlay = harness.dom.window.document.querySelector("[data-slot='dialog-overlay']");
      if (!(dialog instanceof harness.dom.window.HTMLDivElement)) {
        throw new Error("missing dialog content shell");
      }
      if (!(overlay instanceof harness.dom.window.HTMLDivElement)) {
        throw new Error("missing dialog overlay");
      }

      await act(async () => {
        dialog.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await flushUi();
      });

      expect(harness.dom.window.document.querySelector("[role='dialog']")).not.toBeNull();

      await act(async () => {
        overlay.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await flushUi();
      });

      expect(harness.dom.window.document.querySelector("[role='dialog']")).toBeNull();
      expect(useAppStore.getState().filePreview).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
