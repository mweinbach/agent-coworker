import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

type PreviewResult = Awaited<
  ReturnType<typeof import("../src/lib/desktopCommands").readFileForPreview>
>;

let previewResult: PreviewResult = {
  bytes: new Uint8Array(),
  byteLength: 0,
  truncated: false,
};

const readFileForPreviewMock = mock(async () => previewResult);
const getPreferredFileAppMock = mock(async (opts: { path: string }) =>
  opts.path.endsWith(".docx") ? "Word" : null,
);
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

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    getPreferredFileApp: getPreferredFileAppMock,
    readFileForPreview: readFileForPreviewMock,
  }),
);

const docxPreviewModule = await import("../src/lib/docxPreview");
spyOn(docxPreviewModule, "loadDocxPreviewLayout").mockImplementation(loadDocxPreviewLayoutMock);

const { useAppStore } = await import("../src/app/store");
const { reactivateWorkspaceJsonRpcSocketState } = await import(
  "../src/app/store.helpers/jsonRpcSocket"
);
const { RUNTIME } = await import("../src/app/store.helpers/runtimeState");
const { FilePreviewModal, __internalFilePreviewModal } = await import("../src/ui/FilePreviewModal");

function setupPreviewJsdom() {
  return setupJsdom({
    includeAnimationFrame: true,
    extraGlobals: {
      DOMParser: undefined,
    },
    setupWindow: (dom) => {
      (globalThis as Record<string, unknown>).DOMParser = dom.window.DOMParser;
    },
  });
}

function resetAppStore() {
  const state = useAppStore.getState();
  reactivateWorkspaceJsonRpcSocketState("ws-1");
  RUNTIME.jsonRpcSockets.clear();
  RUNTIME.jsonRpcSockets.set("ws-1", {
    readyPromise: Promise.resolve(),
    connect: () => {},
    close: () => {},
    respond: () => true,
    request: async () => ({}),
  } as any);
  useAppStore.setState({
    ...state,
    workspaces: [
      {
        id: "ws-1",
        name: "Workspace",
        path: "/Users/mweinbach/Projects/preview-workspace",
        createdAt: "2026-05-16T00:00:00.000Z",
        lastOpenedAt: "2026-05-16T00:00:00.000Z",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    selectedWorkspaceId: "ws-1",
    workspaceRuntimeById: {
      ...state.workspaceRuntimeById,
      "ws-1": {
        ...state.workspaceRuntimeById["ws-1"],
        serverUrl: "ws://mock",
      },
    },
    filePreview: null,
  } as any);
}

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function waitForUi(predicate: () => boolean) {
  for (let i = 0; i < 20; i++) {
    await flushUi();
    if (predicate()) return;
  }
  throw new Error("timed out waiting for UI update");
}

afterAll(() => {
  mock.restore();
});

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
    const harness = setupPreviewJsdom();

    try {
      const path =
        "/Users/mweinbach/Library/Mobile Documents/com~apple~CloudDocs/Claude/tmp/preview_latency_review.md";
      previewResult = {
        bytes: new TextEncoder().encode(
          "# Preview latency review\n\nThis markdown body should render in a narrower reading column.",
        ),
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
      const description = doc.querySelector("[data-slot='dialog-description']");

      expect(markdownShell?.className).toContain("max-w-[78ch]");
      expect(description?.className).toContain("sr-only");
      expect(description?.textContent).toBe("Markdown preview for preview_latency_review.md");
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
    const harness = setupPreviewJsdom();

    try {
      const path =
        "/Users/mweinbach/Library/Mobile Documents/com~apple~CloudDocs/Claude/tmp/preview_latency_review.docx";
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
      expect(docxShell?.className).toContain("bg-card");
      expect(loadDocxPreviewLayoutMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("keeps clicks inside the popup open and closes from the footer action", async () => {
    const harness = setupPreviewJsdom();

    try {
      const path =
        "/Users/mweinbach/Library/Mobile Documents/com~apple~CloudDocs/Claude/tmp/preview_latency_review.docx";
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
        useAppStore.getState().closeFilePreview();
        root.render(createElement(FilePreviewModal));
        await flushUi();
      });

      expect(useAppStore.getState().filePreview).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test.serial("loads spreadsheet preview data over JSON-RPC and switches sheets", async () => {
    const harness = setupPreviewJsdom();

    try {
      const path = "/Users/mweinbach/Projects/preview-workspace/model.xlsx";
      const requestMock = mock(async (method: string, params?: any) => {
        if (method !== "cowork/workspace/spreadsheet/preview") return {};
        const selectedSheetName = params?.sheetName === "Data" ? "Data" : "Summary";
        return {
          ok: true,
          preview: {
            kind: "xlsx",
            path,
            filename: "model.xlsx",
            sheets: [
              { name: "Summary", rowCount: 2, colCount: 2 },
              { name: "Data", rowCount: 2, colCount: 2 },
            ],
            selectedSheetName,
            viewport: {
              startRow: 0,
              startCol: 0,
              rowCount: 2,
              colCount: 2,
              endRow: 1,
              endCol: 1,
              totalRows: 240,
              totalCols: 2,
              truncatedRows: selectedSheetName === "Summary",
              truncatedCols: false,
            },
            cells:
              selectedSheetName === "Data"
                ? [
                    [
                      { row: 0, col: 0, address: "A1", value: "id" },
                      { row: 0, col: 1, address: "B1", value: "count" },
                    ],
                    [
                      { row: 1, col: 0, address: "A2", value: "GPU-1" },
                      { row: 1, col: 1, address: "B2", value: "8" },
                    ],
                  ]
                : [
                    [
                      { row: 0, col: 0, address: "A1", value: "Metric" },
                      { row: 0, col: 1, address: "B1", value: "Value" },
                    ],
                    [
                      { row: 1, col: 0, address: "A2", value: "Revenue" },
                      { row: 1, col: 1, address: "B2", value: "$12.50" },
                    ],
                  ],
            mergedCells: [],
            columnWidths: [],
            warnings:
              selectedSheetName === "Summary"
                ? ["Showing rows 1-2 and columns 1-2 of 240 rows and 2 columns."]
                : [],
          },
        };
      });
      RUNTIME.jsonRpcSockets.set("ws-1", {
        readyPromise: Promise.resolve(),
        connect: () => {},
        close: () => {},
        respond: () => true,
        request: requestMock,
      } as any);

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
      await waitForUi(
        () =>
          requestMock.mock.calls.length > 0 && doc.body.textContent?.includes("Revenue") === true,
      );
      expect(readFileForPreviewMock).not.toHaveBeenCalled();
      expect(requestMock.mock.calls[0]?.[0]).toBe("cowork/workspace/spreadsheet/preview");
      expect(requestMock.mock.calls[0]?.[1]).toMatchObject({
        cwd: "/Users/mweinbach/Projects/preview-workspace",
        path,
      });
      expect(doc.querySelector("[data-file-preview-spreadsheet='true']")).not.toBeNull();
      expect(doc.body.textContent).toContain("Revenue");
      expect(doc.body.textContent).toContain("Showing rows 1-2");

      const dataTab = Array.from(doc.querySelectorAll("button")).find(
        (button) => button.textContent === "Data",
      );
      if (!dataTab) throw new Error("missing Data sheet tab");

      await act(async () => {
        dataTab.dispatchEvent(
          new harness.dom.window.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            view: harness.dom.window,
          }),
        );
        await flushUi();
      });
      await waitForUi(
        () => harness.dom.window.document.body.textContent?.includes("GPU-1") === true,
      );

      expect(requestMock.mock.calls.at(-1)?.[1]).toMatchObject({ sheetName: "Data" });
      expect(doc.body.textContent).toContain("GPU-1");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});

describe("file preview Windows paths", () => {
  function localPathFromCoworkFileUrl(rawUrl: string): string | null {
    return new URL(rawUrl).searchParams.get("path");
  }

  test("resolves relative markdown links against Windows drive paths", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath(
        "C:\\Users\\Max\\Documents\\notes\\readme.md",
        "../assets/figure one.png",
      ),
    ).toBe("C:\\Users\\Max\\Documents\\assets\\figure one.png");
  });

  test("resolves parent segments without escaping a Windows drive root", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath("C:\\readme.md", "../../etc/config.txt"),
    ).toBe("C:\\etc\\config.txt");
  });

  test("resolves mixed separators and dot segments", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath(
        "C:/Users/Max/Documents/notes/readme.md",
        "..\\./assets//diagram.png",
      ),
    ).toBe("C:/Users/Max/Documents/assets/diagram.png");
  });

  test("keeps POSIX absolute paths stable", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath("/home/max/docs/readme.md", "../assets/a.png"),
    ).toBe("/home/max/assets/a.png");
  });

  test("resolves relative markdown links against UNC paths", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath(
        "\\\\server\\share\\docs\\readme.md",
        "images/diagram.png",
      ),
    ).toBe("\\\\server\\share\\docs\\images\\diagram.png");
  });

  test("normalizes forward-slash UNC paths to Windows UNC paths", () => {
    expect(
      __internalFilePreviewModal.resolveRelativePath(
        "//server/share/docs/readme.md",
        "images/diagram.png",
      ),
    ).toBe("\\\\server\\share\\docs\\images\\diagram.png");
  });

  test("extracts basenames from desktop paths", () => {
    expect(__internalFilePreviewModal.basenamePath("C:\\Users\\Max\\notes\\readme.md")).toBe(
      "readme.md",
    );
    expect(__internalFilePreviewModal.basenamePath("C:\\Users\\Max\\notes\\")).toBe("notes");
    expect(__internalFilePreviewModal.basenamePath("\\\\server\\share\\docs\\readme.md")).toBe(
      "readme.md",
    );
  });

  test("rewrites Windows and UNC file URLs without dropping the host or drive", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "link",
          url: "file:///C:/Users/Max/Documents/readme.md",
          children: [],
        },
        {
          type: "link",
          url: "file://server/share/docs/readme.md",
          children: [],
        },
      ],
    };

    __internalFilePreviewModal.createRemarkResolveRelativeLinks(
      "C:\\Users\\Max\\Documents\\preview.md",
    )()(tree);

    expect(localPathFromCoworkFileUrl(tree.children[0].url)).toBe(
      "C:\\Users\\Max\\Documents\\readme.md",
    );
    expect(localPathFromCoworkFileUrl(tree.children[1].url)).toBe(
      "\\\\server\\share\\docs\\readme.md",
    );
  });

  test("rewrites relative links with URL-special path characters", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "link",
          url: "assets/figure & 1.png",
          children: [],
        },
      ],
    };

    __internalFilePreviewModal.createRemarkResolveRelativeLinks("C:\\Users\\Max\\preview.md")()(
      tree,
    );

    expect(localPathFromCoworkFileUrl(tree.children[0].url)).toBe(
      "C:\\Users\\Max\\assets\\figure & 1.png",
    );
  });
});
