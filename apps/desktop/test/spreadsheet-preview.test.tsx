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

  test.serial("renders workbook controls, formulas, objects, and agent edit prompts", async () => {
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
            selectedSheetName: typeof params?.sheetName === "string" ? params.sheetName : "Summary",
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
                  style: {
                    numberFormat: "$0.00",
                    bold: true,
                    fillColor: "#FFE08A",
                    textColor: "#174A2A",
                  },
                },
              ],
            ],
            mergedCells: [],
            columnWidths: [{ col: 0, widthChars: 18 }],
            tables: [
              {
                name: "RevenueTable",
                ref: "A1:B2",
                startRow: 0,
                startCol: 0,
                endRow: 1,
                endCol: 1,
              },
            ],
            charts: [
              {
                id: "chart1",
                title: "Revenue by Quarter",
                type: "bar",
                anchor: { fromRow: 0, fromCol: 3 },
              },
            ],
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
      expect(doc.body.textContent).toContain("RevenueTable");
      expect(doc.body.textContent).toContain("Revenue by Quarter");

      expect(doc.querySelector<HTMLInputElement>("input[type='search']")).toBeNull();

      const valueCell = doc.querySelector("[data-cell-address='B2']");
      if (!valueCell) throw new Error("missing value cell");
      const valueTd = valueCell.closest("td") as HTMLTableCellElement | null;
      expect(valueTd?.style.backgroundColor).toBe("rgb(255, 224, 138)");
      expect(valueTd?.style.color).toBe("rgb(23, 74, 42)");
      expect(valueTd?.style.fontWeight).toBe("600");
      await act(async () => {
        valueCell.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await flushUi();
      });
      const formulaBar = doc.querySelector<HTMLInputElement>("input[aria-label='Formula bar']");
      if (!formulaBar) throw new Error("missing formula bar");
      expect(formulaBar.value).toBe("=SUM(Data!B2:B10)");

      const promptInput = doc.querySelector<HTMLInputElement>(
        "input[placeholder='Ask, comment, or edit...']",
      );
      if (!promptInput) throw new Error("missing agent prompt input");
      await act(async () => {
        setInputValue(harness.dom.window, promptInput, "Increase revenue by ten percent");
        await flushUi();
      });
      const askButton = doc.querySelector<HTMLButtonElement>(
        "button[aria-label='Send spreadsheet request']",
      );
      if (!askButton) throw new Error("missing ask button");
      await act(async () => {
        askButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await flushUi();
      });

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const prompt = sendMessageMock.mock.calls[0]?.[0];
      expect(prompt).toContain('<spreadsheet_canvas_request version="1">');
      expect(prompt).toContain(
        "<instruction>If the user asks for feedback, analysis, or a comment, answer directly and do not edit the workbook.</instruction>",
      );
      expect(prompt).toContain('<workbook file_name="model.xlsx" path="');
      expect(prompt).toContain("<active_sheet>Summary</active_sheet>");
      expect(prompt).toContain('<selection range="B2" cell_count="1">');
      expect(prompt).toContain('<active_cell address="B2">');
      expect(prompt).toContain("<formula>=SUM(Data!B2:B10)</formula>");
      expect(prompt).toContain("<style>bold, fill #FFE08A");
      expect(prompt).toContain('<table name="RevenueTable" ref="A1:B2" />');
      expect(prompt).toContain("<tables>");
      expect(prompt).toContain('<chart id="chart1" title="Revenue by Quarter"');
      expect(prompt).toContain("<user_request>Increase revenue by ten percent</user_request>");
      expect(prompt).toContain("</spreadsheet_canvas_request>");

      const dataSheetButton = Array.from(doc.querySelectorAll("[role='tab']")).find(
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
  });

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
            tables: [],
            charts: [],
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
      // Compact mode keeps the working surface quiet: no duplicate search/status strip.
      expect(doc.querySelector<HTMLInputElement>("input[type='search']")).toBeNull();
      // Compact canvas mode should avoid duplicating the file title chrome owned by the window.
      expect(doc.body.textContent).not.toContain("Cowork Workbook");

      // Should render the grid as the flexing body of the compact canvas surface.
      const tableWrapper = doc.querySelector("[data-spreadsheet-grid='true']");
      expect(tableWrapper?.className).toContain("flex-1");
      expect(tableWrapper?.className).not.toContain("max-h-[58vh]");
      expect(doc.querySelector("[data-spreadsheet-preview='true']")?.className).toContain(
        "bg-[var(--surface-spreadsheet)]",
      );
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
