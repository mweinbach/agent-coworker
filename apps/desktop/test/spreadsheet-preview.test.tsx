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

function resetAppStore(sendMessage?: AppStoreState["sendMessage"]) {
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
    workspaceRuntimeById: {
      ...state.workspaceRuntimeById,
      "ws-1": {
        ...state.workspaceRuntimeById["ws-1"],
        serverUrl: "ws://mock",
      },
    },
    filePreview: null,
    sendMessage: sendMessage ?? originalSendMessage,
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

describe("SpreadsheetPreview", () => {
  beforeEach(() => {
    resetAppStore();
  });

  afterEach(() => {
    RUNTIME.jsonRpcSockets.clear();
    useAppStore.setState({ sendMessage: originalSendMessage } as Partial<AppStoreState>);
  });

  test.serial(
    "renders workbook controls, search, cell metadata, and agent edit prompts",
    async () => {
      const harness = setupJsdom({ includeAnimationFrame: true });
      const sendMessageMock = mock(async () => true);
      resetAppStore(sendMessageMock);

      let root: ReturnType<typeof createRoot> | null = null;
      try {
        const path = "/Users/mweinbach/Projects/preview-workspace/model.xlsx";
        const requestMock = mock(async (method: string, params?: Record<string, unknown>) => {
          expect(method).toBe("cowork/workspace/spreadsheet/preview");
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
              selectedSheetName:
                typeof params?.sheetName === "string" ? params.sheetName : "Summary",
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
                  { row: 0, col: 0, address: "A1", value: "Metric" },
                  { row: 0, col: 1, address: "B1", value: "Value" },
                ],
                [
                  { row: 1, col: 0, address: "A2", value: "Revenue" },
                  {
                    row: 1,
                    col: 1,
                    address: "B2",
                    value: "$12.50",
                    formattedValue: "$12.50",
                    formula: "SUM(Data!B2:B10)",
                    style: { numberFormat: "$0.00", bold: true },
                  },
                ],
              ],
              mergedCells: [],
              columnWidths: [{ col: 0, widthChars: 18 }],
              warnings: [],
            },
          };
        });
        RUNTIME.jsonRpcSockets.set("ws-1", {
          readyPromise: Promise.resolve(),
          connect: () => {},
          close: () => {},
          respond: () => true,
          request: requestMock,
        } as never);

        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        await act(async () => {
          root.render(createElement(SpreadsheetPreview, { path }));
          await flushUi();
          await flushUi();
        });

        const doc = harness.dom.window.document;
        expect(doc.querySelector("[data-spreadsheet-preview='true']")).not.toBeNull();
        expect(doc.body.textContent).toContain("Summary");
        expect(doc.body.textContent).toContain("Data");
        expect(doc.body.textContent).toContain("Revenue");

        const searchInput = doc.querySelector<HTMLInputElement>("input[type='search']");
        if (!searchInput) throw new Error("missing search input");
        await act(async () => {
          setInputValue(harness.dom.window, searchInput, "Revenue");
          await flushUi();
        });
        expect(doc.body.textContent).toContain("1 visible matches");

        const valueCell = Array.from(doc.querySelectorAll("td button")).find(
          (cell) => cell.textContent?.trim() === "$12.50",
        );
        if (!valueCell) throw new Error("missing value cell");
        await act(async () => {
          valueCell.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
          await flushUi();
        });
        expect(doc.body.textContent).toContain("B2");
        expect(doc.body.textContent).toContain("Formula: =SUM(Data!B2:B10)");
        expect(doc.body.textContent).toContain("Number format: $0.00");

        const promptInput = doc.querySelector<HTMLInputElement>(
          "input[placeholder='Ask agent to edit this file...']",
        );
        if (!promptInput) throw new Error("missing agent prompt input");
        await act(async () => {
          setInputValue(harness.dom.window, promptInput, "Increase revenue by ten percent");
          await flushUi();
        });
        const askButton = doc.querySelector<HTMLButtonElement>(
          "button[aria-label='Ask model to edit spreadsheet']",
        );
        if (!askButton) throw new Error("missing ask button");
        await act(async () => {
          askButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
          await flushUi();
        });

        expect(sendMessageMock).toHaveBeenCalledTimes(1);
        const prompt = sendMessageMock.mock.calls[0]?.[0];
        expect(prompt).toContain("[Spreadsheet Collaborative Edit]");
        expect(prompt).toContain("Active sheet: Summary");
        expect(prompt).toContain("Selected cell: B2");
        expect(prompt).toContain("Search query: Revenue");
        expect(prompt).toContain("Increase revenue by ten percent");

        const dataSheetButton = Array.from(doc.querySelectorAll("button")).find(
          (button) => button.textContent === "Data",
        );
        if (!dataSheetButton) throw new Error("missing Data sheet button");
        await act(async () => {
          dataSheetButton.dispatchEvent(
            new harness.dom.window.MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: harness.dom.window,
            }),
          );
          await flushUi();
          await flushUi();
        });
        expect(requestMock.mock.calls.at(-1)?.[1]).toMatchObject({ sheetName: "Data" });
      } finally {
        if (root) {
          try {
            await act(async () => {
              root!.unmount();
            });
          } catch {}
        }
        useAppStore.setState({ sendMessage: originalSendMessage } as Partial<AppStoreState>);
        harness.restore();
      }
    },
  );

  test.serial("renders in compact mode for canvas integration", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    resetAppStore();

    let root: ReturnType<typeof createRoot> | null = null;
    try {
      const path = "/Users/mweinbach/Projects/preview-workspace/model.xlsx";
      const requestMock = mock(async () => {
        return {
          ok: true,
          preview: {
            kind: "xlsx",
            path,
            filename: "model.xlsx",
            sheets: [{ name: "Summary", rowCount: 1, colCount: 1 }],
            selectedSheetName: "Summary",
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
            warnings: [],
          },
        };
      });
      RUNTIME.jsonRpcSockets.set("ws-1", {
        readyPromise: Promise.resolve(),
        connect: () => {},
        close: () => {},
        respond: () => true,
        request: requestMock,
      } as never);

      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(SpreadsheetPreview, { path, compact: true }));
        await flushUi();
        await flushUi();
      });

      const doc = harness.dom.window.document;
      // Should render compact viewport label in pagination bar
      expect(doc.body.textContent).toContain("Rows 1-1 of 1");
      // Should NOT render duplicate top header with filename
      const titleElement = Array.from(doc.querySelectorAll("div")).find(
        (div) => div.textContent === "model.xlsx",
      );
      expect(titleElement).toBeUndefined();

      // Should render table container with flex-1
      const tableWrapper = doc.querySelector(".overflow-auto.rounded-md.border");
      expect(tableWrapper?.className).toContain("flex-1");
      expect(tableWrapper?.className).not.toContain("max-h-[58vh]");
    } finally {
      if (root) {
        try {
          await act(async () => {
            root!.unmount();
          });
        } catch {}
      }
      useAppStore.setState({ sendMessage: originalSendMessage } as Partial<AppStoreState>);
      harness.restore();
    }
  });
});
