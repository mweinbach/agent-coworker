import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

const { useAppStore } = await import("../src/app/store");
const { reactivateWorkspaceJsonRpcSocketState } = await import(
  "../src/app/store.helpers/jsonRpcSocket"
);
const { RUNTIME } = await import("../src/app/store.helpers/runtimeState");
const { SpreadsheetPreview } = await import("../src/ui/SpreadsheetPreview");

type AppStoreState = ReturnType<typeof useAppStore.getState>;

const originalSendMessage = useAppStore.getState().sendMessage;

const PATH = "/Users/mweinbach/Projects/preview-workspace/grid.xlsx";

function buildPreview() {
  return {
    ok: true as const,
    preview: {
      kind: "xlsx" as const,
      path: PATH,
      filename: "grid.xlsx",
      sheets: [{ name: "Sheet1", rowCount: 2, colCount: 2 }],
      selectedSheetName: "Sheet1",
      viewport: {
        startRow: 0,
        startCol: 0,
        rowCount: 2,
        colCount: 2,
        endRow: 1,
        endCol: 1,
        totalRows: 2,
        totalCols: 2,
        truncatedRows: false,
        truncatedCols: false,
      },
      cells: [
        [
          { row: 0, col: 0, address: "A1", value: "Name" },
          { row: 0, col: 1, address: "B1", value: "Q1" },
        ],
        [
          { row: 1, col: 0, address: "A2", value: "West" },
          { row: 1, col: 1, address: "B2", value: "100" },
        ],
      ],
      mergedCells: [],
      columnWidths: [],
      warnings: [],
    },
  };
}

type EditParams = { address?: string; rawInput?: string; sheetName?: string; path?: string };

function installSocket(): { editCalls: EditParams[] } {
  const editCalls: EditParams[] = [];
  const requestMock = mock(async (method: string, params?: EditParams) => {
    if (method === "cowork/workspace/spreadsheet/preview") return buildPreview();
    if (method === "cowork/workspace/spreadsheet/edit") {
      editCalls.push(params ?? {});
      return { ok: true };
    }
    throw new Error(`unexpected method ${method}`);
  });
  RUNTIME.jsonRpcSockets.set("ws-1", {
    readyPromise: Promise.resolve(),
    connect: () => {},
    close: () => {},
    respond: () => true,
    request: requestMock,
  } as never);
  return { editCalls };
}

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
    isCanvasMaximized: false,
    workspaceRuntimeById: {
      ...state.workspaceRuntimeById,
      "ws-1": { ...state.workspaceRuntimeById["ws-1"], serverUrl: "ws://mock" },
    },
    filePreview: null,
    sendMessage: originalSendMessage,
  } as Partial<AppStoreState>);
}

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function setInputValue(window: Window, input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("missing input value setter");
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function gridCell(doc: Document, text: string): Element {
  const cell = Array.from(doc.querySelectorAll("td button")).find(
    (el) => el.textContent?.trim() === text,
  );
  if (!cell) throw new Error(`missing cell ${text}`);
  return cell;
}

async function openMoreMenu(doc: Document, window: Window) {
  const moreButton = doc.querySelector<HTMLButtonElement>(
    "button[aria-label='More spreadsheet options']",
  );
  if (!moreButton) throw new Error("missing spreadsheet more button");
  await act(async () => {
    moreButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await flushUi();
  });
}

function menuItem(doc: Document, text: string): Element {
  const item = Array.from(doc.querySelectorAll("[role='menuitem']")).find(
    (el) => el.textContent?.trim() === text,
  );
  if (!item) throw new Error(`missing menu item ${text}`);
  return item;
}

describe("SpreadsheetPreview editing", () => {
  beforeEach(() => {
    resetAppStore();
  });

  afterEach(() => {
    RUNTIME.jsonRpcSockets.clear();
    useAppStore.setState({ sendMessage: originalSendMessage } as Partial<AppStoreState>);
  });

  test.serial("double-click + type + Enter writes the cell via the edit method", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const { editCalls } = installSocket();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(SpreadsheetPreview, { path: PATH }));
        await flushUi();
        await flushUi();
      });

      const doc = harness.dom.window.document;
      await act(async () => {
        gridCell(doc, "100").dispatchEvent(
          new harness.dom.window.MouseEvent("dblclick", { bubbles: true }),
        );
        await flushUi();
      });

      const editInput = doc.querySelector<HTMLInputElement>("input[aria-label='Edit B2']");
      if (!editInput) throw new Error("missing edit input");
      await act(async () => {
        setInputValue(harness.dom.window, editInput, "999");
        await flushUi();
      });
      await act(async () => {
        editInput.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
        await flushUi();
        await flushUi();
      });

      expect(editCalls.length).toBe(1);
      expect(editCalls[0]).toMatchObject({
        address: "B2",
        rawInput: "999",
        sheetName: "Sheet1",
        path: PATH,
      });
    } finally {
      if (root) {
        try {
          await act(async () => root!.unmount());
        } catch {}
      }
      harness.restore();
    }
  });

  test.serial("formula bar reflects selection and arrow keys move the active cell", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    installSocket();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(SpreadsheetPreview, { path: PATH }));
        await flushUi();
        await flushUi();
      });

      const doc = harness.dom.window.document;
      await act(async () => {
        gridCell(doc, "Name").dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
        await flushUi();
      });

      const formulaBar = doc.querySelector<HTMLInputElement>("input[aria-label='Formula bar']");
      if (!formulaBar) throw new Error("missing formula bar");
      expect(formulaBar.value).toBe("Name");

      const grid = doc.querySelector("[data-spreadsheet-grid='true']");
      if (!grid) throw new Error("missing grid");
      await act(async () => {
        grid.dispatchEvent(
          new harness.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
        await flushUi();
      });
      // moved A1 -> A2
      expect(formulaBar.value).toBe("West");
    } finally {
      if (root) {
        try {
          await act(async () => root!.unmount());
        } catch {}
      }
      harness.restore();
    }
  });

  test.serial("maximize toggle flips the store flag", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    installSocket();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(SpreadsheetPreview, { path: PATH }));
        await flushUi();
        await flushUi();
      });

      const doc = harness.dom.window.document;
      await openMoreMenu(doc, harness.dom.window);
      const maximize = menuItem(doc, "Maximize spreadsheet");
      expect(useAppStore.getState().isCanvasMaximized).toBe(false);
      await act(async () => {
        maximize.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await flushUi();
      });
      expect(useAppStore.getState().isCanvasMaximized).toBe(true);
    } finally {
      if (root) {
        try {
          await act(async () => root!.unmount());
        } catch {}
      }
      harness.restore();
    }
  });

  test.serial("toolbar clear, undo, and redo write real cell edits", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const { editCalls } = installSocket();
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(SpreadsheetPreview, { path: PATH }));
        await flushUi();
        await flushUi();
      });

      const doc = harness.dom.window.document;
      await act(async () => {
        gridCell(doc, "100").dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
        await flushUi();
      });

      await openMoreMenu(doc, harness.dom.window);
      const clearButton = menuItem(doc, "Clear");
      await act(async () => {
        clearButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await flushUi();
        await flushUi();
      });

      await openMoreMenu(doc, harness.dom.window);
      const undoButton = menuItem(doc, "Undo");
      await act(async () => {
        undoButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await flushUi();
        await flushUi();
      });

      await openMoreMenu(doc, harness.dom.window);
      const redoButton = menuItem(doc, "Redo");
      await act(async () => {
        redoButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await flushUi();
        await flushUi();
      });

      expect(editCalls.map((call) => call.rawInput)).toEqual(["", "100", ""]);
      expect(editCalls.every((call) => call.address === "B2")).toBe(true);
    } finally {
      if (root) {
        try {
          await act(async () => root!.unmount());
        } catch {}
      }
      harness.restore();
    }
  });
});

describe("editSpreadsheetCell store action", () => {
  beforeEach(() => {
    resetAppStore();
  });
  afterEach(() => {
    RUNTIME.jsonRpcSockets.clear();
  });

  test.serial("issues cowork/workspace/spreadsheet/edit with the cell params", async () => {
    const { editCalls } = installSocket();
    const result = await useAppStore.getState().editSpreadsheetCell(PATH, {
      sheetName: "Sheet1",
      address: "C4",
      rawInput: "=SUM(A1:A2)",
    });
    expect(result).toEqual({ ok: true });
    expect(editCalls).toEqual([
      {
        cwd: "/Users/mweinbach/Projects/preview-workspace",
        path: PATH,
        sheetName: "Sheet1",
        address: "C4",
        rawInput: "=SUM(A1:A2)",
      },
    ]);
  });
});
