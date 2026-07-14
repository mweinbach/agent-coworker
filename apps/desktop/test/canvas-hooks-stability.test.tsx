import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type {
  CanvasDocumentCloseRequest,
  CanvasDocumentOpenRequest,
  CanvasDocumentRevisionRequest,
  CanvasDocumentSaveAsRequest,
  CanvasDocumentSaveRequest,
} from "../../../src/shared/canvasDocument";
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
const openCanvasDocumentMock = mock(
  async (_workspaceId: string, input: Omit<CanvasDocumentOpenRequest, "cwd">) => {
    const content = new TextDecoder().decode(previewResult.bytes);
    return {
      ok: true as const,
      document: {
        documentId: input.documentId,
        generation: input.generation,
        path: input.path,
        content,
        truncated: previewResult.truncated,
        revision: {
          modifiedAtMs: 1,
          changeTimeMs: 1,
          size: previewResult.byteLength,
          fingerprint: `sha256:${content}`,
        },
      },
    };
  },
);
const readCanvasDocumentRevisionMock = mock(
  async (_workspaceId: string, input: Omit<CanvasDocumentRevisionRequest, "cwd">) => ({
    ok: true as const,
    documentId: input.documentId,
    generation: input.generation,
    path: "/Users/mweinbach/Projects/preview-workspace/notes.md",
    revision: {
      modifiedAtMs: 1,
      changeTimeMs: 1,
      size: previewResult.byteLength,
      fingerprint: `sha256:${new TextDecoder().decode(previewResult.bytes)}`,
    },
  }),
);
const saveCanvasDocumentMock = mock(
  async (_workspaceId: string, input: Omit<CanvasDocumentSaveRequest, "cwd">) => ({
    ok: true as const,
    documentId: input.documentId,
    generation: input.generation,
    editRevision: input.editRevision,
    path: "/Users/mweinbach/Projects/preview-workspace/notes.md",
    revision: {
      modifiedAtMs: 2,
      changeTimeMs: 2,
      size: input.content.length,
      fingerprint: `sha256:${input.content}`,
    },
    status: "saved" as const,
  }),
);
const saveCanvasDocumentAsMock = mock(
  async (_workspaceId: string, input: Omit<CanvasDocumentSaveAsRequest, "cwd">) => ({
    ok: true as const,
    documentId: input.documentId,
    generation: input.generation,
    editRevision: input.editRevision,
    path: input.path,
    revision: {
      modifiedAtMs: 2,
      changeTimeMs: 2,
      size: input.content.length,
      fingerprint: `sha256:${input.content}`,
    },
    status: "saved" as const,
  }),
);
const closeCanvasDocumentMock = mock(
  async (_workspaceId: string, input: Omit<CanvasDocumentCloseRequest, "cwd">) => ({
    ok: true as const,
    documentId: input.documentId,
    generation: input.generation,
  }),
);

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
    openCanvasDocument: openCanvasDocumentMock,
    readCanvasDocumentRevision: readCanvasDocumentRevisionMock,
    saveCanvasDocument: saveCanvasDocumentMock,
    saveCanvasDocumentAs: saveCanvasDocumentAsMock,
    closeCanvasDocument: closeCanvasDocumentMock,
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

type InputChangeProps = {
  onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;
};

function setInputValue(
  harness: ReturnType<typeof setupJsdom>,
  input: HTMLInputElement,
  value: string,
) {
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(
    harness.dom.window.HTMLInputElement.prototype,
    "value",
  )?.set;
  prototypeValueSetter?.call(input, value);
  // The Bun preload imports React before jsdom exists, so direct DOM events
  // alone do not reliably drive controlled fields; call the React prop too.
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? ((input as unknown as Record<string, unknown>)[propsKey] as InputChangeProps)
    : {};
  props.onChange?.({ target: input, currentTarget: input });
  input.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
}

describe("Canvas hooks stability across file-type switches", () => {
  beforeEach(() => {
    previewResult = makePreviewResult("# Heading\n\n1. one\n2. two\n");
    readFileForPreviewMock.mockClear();
    writeFileMock.mockClear();
    openCanvasDocumentMock.mockClear();
    readCanvasDocumentRevisionMock.mockClear();
    saveCanvasDocumentMock.mockClear();
    saveCanvasDocumentAsMock.mockClear();
    closeCanvasDocumentMock.mockClear();
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

  test.serial(
    "shows markdown formatting only in source mode where it edits the selection",
    async () => {
      const harness = setupJsdom({ includeAnimationFrame: true });
      const mdPath = "/Users/mweinbach/Projects/preview-workspace/notes.md";
      useAppStore.setState({ canvasShowFormattingBar: true } as Partial<AppStoreState>);
      let root: ReturnType<typeof createRoot> | null = null;
      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          root!.render(createElement(Canvas, { path: mdPath }));
          await flushUi();
        });
        for (
          let attempt = 0;
          attempt < 10 && harness.dom.window.document.body.textContent?.includes("Reading file...");
          attempt += 1
        ) {
          await act(async () => {
            await flushUi();
          });
        }
        expect(harness.dom.window.document.body.textContent).not.toContain("Reading file...");

        expect(harness.dom.window.document.querySelector("button[title='Bold']")).toBeNull();
        await act(async () => {
          useAppStore.getState().setCanvasActiveTab("edit");
          await flushUi();
        });

        expect(useAppStore.getState().canvasActiveTab).toBe("edit");
        let sourceTextarea = harness.dom.window.document.querySelector<HTMLTextAreaElement>(
          '[data-slot="tabs-content"][data-state="active"] textarea',
        );
        for (let attempt = 0; attempt < 10 && !sourceTextarea; attempt += 1) {
          await act(async () => {
            await flushUi();
          });
          sourceTextarea = harness.dom.window.document.querySelector<HTMLTextAreaElement>(
            '[data-slot="tabs-content"][data-state="active"] textarea',
          );
        }
        expect(sourceTextarea?.value).toBe("# Heading\n\n1. one\n2. two\n");
        sourceTextarea?.setSelectionRange(2, 9);
        const boldButton = harness.dom.window.document.querySelector(
          "button[title='Bold']",
        ) as HTMLButtonElement | null;
        expect(boldButton).not.toBeNull();
        await act(async () => {
          boldButton?.click();
          await flushUi();
        });
        expect(sourceTextarea?.value).toBe("# **Heading**\n\n1. one\n2. two\n");
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
    },
  );

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
          await flushUi();
        });
      }
      // The truncated-preview guard must ignore the edit outright: a (buggy)
      // scheduled autosave would synchronously flip the save badge to
      // "Unsaved" before its debounce timer ever fired, so no fixed sleep
      // sized to the 500ms debounce is needed to detect it.
      expect(harness.dom.window.document.body.textContent).not.toContain("Unsaved");
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

  test.serial("retains the prompt and announces a rejected send", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const sendMessageMock = mock(async () => false);
    useAppStore.setState({ sendMessage: sendMessageMock } as Partial<AppStoreState>);
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root!.render(
          createElement(Canvas, {
            path: "/Users/mweinbach/Projects/preview-workspace/notes.md",
          }),
        );
        await flushUi();
      });

      const input = harness.dom.window.document.querySelector<HTMLInputElement>(
        'input[placeholder="Ask model to edit this document..."]',
      );
      expect(input).not.toBeNull();
      await act(async () => {
        if (!input) return;
        input.focus();
        setInputValue(harness, input, "Tighten the introduction");
        input.dispatchEvent(
          new harness.dom.window.InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: "Tighten the introduction",
          }),
        );
        input.dispatchEvent(new harness.dom.window.Event("change", { bubbles: true }));
        await flushUi();
      });

      const sendButton = input?.parentElement?.querySelector<HTMLButtonElement>("button");
      expect(sendButton).not.toBeNull();
      expect(input?.value).toBe("Tighten the introduction");
      expect(sendButton?.disabled).toBe(false);
      await act(async () => {
        sendButton?.click();
        await flushUi();
      });

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(input?.value).toBe("Tighten the introduction");
      const alert = harness.dom.window.document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("The request was not sent");
      expect(alert?.getAttribute("aria-live")).toBe("assertive");
      expect(alert?.getAttribute("aria-atomic")).toBe("true");
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
      }
      harness.restore();
    }
  });

  test.serial("clears the prompt only after the send is acknowledged", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const sendResult = Promise.withResolvers<boolean>();
    const sendMessageMock = mock(async () => await sendResult.promise);
    useAppStore.setState({ sendMessage: sendMessageMock } as Partial<AppStoreState>);
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root!.render(
          createElement(Canvas, {
            path: "/Users/mweinbach/Projects/preview-workspace/notes.md",
          }),
        );
        await flushUi();
      });

      const input = harness.dom.window.document.querySelector<HTMLInputElement>(
        'input[placeholder="Ask model to edit this document..."]',
      );
      expect(input).not.toBeNull();
      await act(async () => {
        if (!input) return;
        input.focus();
        setInputValue(harness, input, "Add a concise summary");
        input.dispatchEvent(
          new harness.dom.window.InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: "Add a concise summary",
          }),
        );
        input.dispatchEvent(new harness.dom.window.Event("change", { bubbles: true }));
        await flushUi();
      });

      const sendButton = input?.parentElement?.querySelector<HTMLButtonElement>("button");
      expect(sendButton).not.toBeNull();
      expect(input?.value).toBe("Add a concise summary");
      expect(sendButton?.disabled).toBe(false);
      await act(async () => {
        sendButton?.click();
        await flushUi();
      });

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(input?.value).toBe("Add a concise summary");
      expect(input?.disabled).toBe(true);
      expect(sendButton?.disabled).toBe(true);

      sendResult.resolve(true);
      await act(async () => {
        await sendResult.promise;
        await flushUi();
      });

      expect(input?.value).toBe("");
      expect(input?.disabled).toBe(false);
      expect(harness.dom.window.document.querySelector('[role="alert"]')).toBeNull();
    } finally {
      if (root) {
        await act(async () => {
          root!.unmount();
        });
      }
      harness.restore();
    }
  });
});
