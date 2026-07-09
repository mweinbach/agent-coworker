import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

function makePreviewResult(text: string, truncated = false) {
  const bytes = new TextEncoder().encode(text);
  return { bytes, byteLength: bytes.byteLength, truncated };
}

let previewResult = makePreviewResult("# Heading\n\n1. one\n2. two\n");

// Canvas reads files through desktopCommands; serve deterministic markdown so a
// re-render with a new path exercises the editor render path without real IPC.
const readFileForPreviewMock = mock(async () => previewResult);
const writeFileMock = mock(async () => {});

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    readFileForPreview: readFileForPreviewMock,
    writeFile: writeFileMock,
  }),
);

mock.module("../src/ui/LazyUniverSpreadsheetCanvas", () => ({
  LazyUniverSpreadsheetCanvas: ({ path }: { path: string }) =>
    createElement("div", { "data-testid": "spreadsheet-canvas" }, path),
}));

const { useAppStore } = await import("../src/app/store");
const { reactivateWorkspaceJsonRpcSocketState } = await import(
  "../src/app/store.helpers/jsonRpcSocket"
);
const { RUNTIME } = await import("../src/app/store.helpers/runtimeState");
const { Canvas } = await import("../src/ui/Canvas");
const { CanvasFilePreviewLayout } = await import("../src/ui/canvas/CanvasFilePreviewLayout");

type AppStoreState = ReturnType<typeof useAppStore.getState>;

const originalSendMessage = useAppStore.getState().sendMessage;

function resetAppStore() {
  const state = useAppStore.getState();
  reactivateWorkspaceJsonRpcSocketState("ws-1");
  RUNTIME.jsonRpcSockets.clear();
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
    selectedThreadId: "thread-1",
    canvasActiveTab: "preview",
    filePreview: null,
    sendMessage: originalSendMessage,
  } as Partial<AppStoreState>);
}

function installSpreadsheetSocket(path: string) {
  const requestMock = mock(async () => ({
    ok: true,
    preview: {
      kind: "csv",
      path,
      filename: "data.csv",
      sheets: [{ name: "Sheet1", rowCount: 1, colCount: 1 }],
      selectedSheetName: "Sheet1",
      viewport: {
        startRow: 0,
        startCol: 0,
        rowCount: 1,
        colCount: 1,
        endRow: 0,
        endCol: 0,
        totalRows: 1,
        totalCols: 1,
        truncatedRows: false,
        truncatedCols: false,
      },
      cells: [[{ row: 0, col: 0, address: "A1", value: "Metric" }]],
      mergedCells: [],
      columnWidths: [],
      tables: [],
      charts: [],
      warnings: [],
    },
  }));
  RUNTIME.jsonRpcSockets.set("ws-1", {
    readyPromise: Promise.resolve(),
    connect: () => {},
    close: () => {},
    respond: () => true,
    request: requestMock,
  } as never);
}

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("Canvas hooks stability across file-type switches", () => {
  beforeEach(() => {
    previewResult = makePreviewResult("# Heading\n\n1. one\n2. two\n");
    readFileForPreviewMock.mockClear();
    writeFileMock.mockClear();
    resetAppStore();
  });

  afterEach(() => {
    RUNTIME.jsonRpcSockets.clear();
    useAppStore.setState({ sendMessage: originalSendMessage } as Partial<AppStoreState>);
  });

  // Regression: Canvas is mounted unkeyed (App.tsx), so switching the `path`
  // prop between a document kind (markdown) and a preview kind (csv/pptx) used
  // to change the number of hooks executed and crash React with
  // "rendered fewer hooks than during the previous render". This re-renders the
  // SAME root across kinds and fails if React throws a hooks-order error.
  test.serial("re-renders across markdown <-> csv without a hooks error", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const mdPath = "/Users/mweinbach/Projects/preview-workspace/notes.md";
    const csvPath = "/Users/mweinbach/Projects/preview-workspace/data.csv";
    installSpreadsheetSocket(csvPath);

    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      // 1. Document kind: every editor hook runs.
      await act(async () => {
        root!.render(createElement(Canvas, { path: mdPath }));
        await flushUi();
        await flushUi();
      });
      expect(harness.dom.window.document.body.textContent).toContain("Heading");

      // 2. Preview kind on the SAME instance: this is the crashing transition.
      await act(async () => {
        root!.render(createElement(Canvas, { path: csvPath }));
        await flushUi();
        await flushUi();
      });

      // 3. Back to a document kind.
      await act(async () => {
        root!.render(createElement(Canvas, { path: mdPath }));
        await flushUi();
        await flushUi();
      });
      expect(harness.dom.window.document.body.textContent).toContain("Heading");
    } finally {
      if (root) {
        try {
          await act(async () => {
            root!.unmount();
          });
        } catch {}
      }
      harness.restore();
    }
  });

  test.serial("omits duplicate spreadsheet filename chrome in canvas mode", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root!.render(
          createElement(
            CanvasFilePreviewLayout,
            {
              isCanvasMode: true,
              isAgentBusy: false,
              fileName: "model.xlsx",
              previewKind: "xlsx",
              onClose: () => {},
            },
            createElement("div", null, "Workbook body"),
          ),
        );
        await flushUi();
      });

      expect(harness.dom.window.document.body.textContent).toContain("Workbook body");
      expect(harness.dom.window.document.body.textContent).not.toContain("model.xlsx");
      expect(
        harness.dom.window.document.querySelector("button[title='Close Window']"),
      ).not.toBeNull();
    } finally {
      if (root) {
        try {
          await act(async () => {
            root!.unmount();
          });
        } catch {}
      }
      harness.restore();
    }
  });

  test.serial("explains truncated previews and keeps markdown editing read-only", async () => {
    previewResult = makePreviewResult("# Large file preview\n\nVisible prefix only.\n", true);
    const harness = setupJsdom({ includeAnimationFrame: true });
    const mdPath = "/Users/mweinbach/Projects/preview-workspace/large.md";
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root!.render(createElement(Canvas, { path: mdPath }));
        await flushUi();
        await flushUi();
      });

      const text = harness.dom.window.document.body.textContent ?? "";
      expect(text).toContain("Editing disabled for large preview");
      expect(text).toContain(
        "Editing is disabled to avoid overwriting the full file with partial content.",
      );
      // Preview is read-only rendered markdown; source edit is a Textarea that
      // must be read-only when the preview is truncated.
      expect(harness.dom.window.document.querySelector("[contenteditable]")).toBeNull();

      await act(async () => {
        root!.unmount();
      });
      root = null;
      useAppStore.setState({ canvasActiveTab: "edit" } as Partial<AppStoreState>);
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(Canvas, { path: mdPath }));
        await flushUi();
        await flushUi();
      });

      const textarea = harness.dom.window.document.querySelector("textarea");
      expect(textarea?.readOnly).toBe(true);
      expect(harness.dom.window.document.body.textContent).toContain(
        "Editing disabled for large preview",
      );

      if (textarea) {
        await act(async () => {
          textarea.value = "# Mutated truncated content";
          textarea.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 650));
        });
      }
      expect(writeFileMock).not.toHaveBeenCalled();
    } finally {
      if (root) {
        try {
          await act(async () => {
            root!.unmount();
          });
        } catch {}
      }
      harness.restore();
    }
  });
});
