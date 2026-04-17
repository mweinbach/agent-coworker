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

const copyPathMock = mock(async () => {});
const readFileForPreviewMock = mock(async () => previewResult);
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
  copyPath: copyPathMock,
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
    copyPathMock.mockClear();
    readFileForPreviewMock.mockClear();
    loadDocxPreviewLayoutMock.mockClear();
    resetAppStore();
  });

  test.serial("shows a single-line path row with copy/reveal actions and a constrained markdown shell", async () => {
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
      const pathNode = doc.querySelector("[data-file-preview-path='true']");
      const markdownShell = doc.querySelector("[data-file-preview-markdown-shell='true']");
      const copyButton = Array.from(doc.querySelectorAll("button")).find((button) => button.textContent?.includes("Copy path"));

      expect(pathNode?.className).toContain("truncate");
      expect(pathNode?.className).toContain("whitespace-nowrap");
      expect(pathNode?.textContent).toBe(path);
      expect(markdownShell?.className).toContain("max-w-[78ch]");
      expect(doc.body.textContent).toContain("Reveal");
      expect(doc.body.textContent).toContain("Open externally");
      if (!(copyButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing copy path button");
      }

      await act(async () => {
        copyButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(copyPathMock.mock.calls).toEqual([[{ path }]]);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("shows the docx approximation note for in-app Word previews", async () => {
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
      const note = doc.querySelector("[data-file-preview-docx-note='true']");
      const footer = doc.querySelector("[data-file-preview-docx-footer='true']");
      const headerImage = doc.querySelector("img[alt='Document header']");

      expect(note?.textContent).toContain("may not match Word layout exactly");
      expect(doc.body.textContent).toContain("Docx title");
      expect(footer?.textContent).toContain("Creative Strategies");
      expect(headerImage).not.toBeNull();
      expect(loadDocxPreviewLayoutMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
