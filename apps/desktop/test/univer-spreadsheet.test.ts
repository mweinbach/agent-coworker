import { describe, expect, test } from "bun:test";
import { BooleanNumber, CellValueType, HorizontalAlign } from "@univerjs/core";

import type { SpreadsheetWorkbookSnapshot } from "../../../src/shared/spreadsheetPreview";
import {
  buildUniverSpreadsheetPrompt,
  cloneUniverWorkbookData,
  diffUniverWorkbookPatches,
  selectionContextFromSnapshot,
  selectionContextFromWorkbook,
  spreadsheetSnapshotToUniverData,
} from "../src/lib/univerSpreadsheet";

const WORKBOOK: SpreadsheetWorkbookSnapshot = {
  kind: "xlsx",
  path: "/workspace/model.xlsx",
  filename: "model.xlsx",
  fileVersion: { modifiedAtMs: 1, changeTimeMs: 1, size: 1, fingerprint: "1:1:1" },
  activeSheetName: "Summary",
  warnings: [],
  sheets: [
    {
      id: "sheet-1",
      name: "Summary",
      rowCount: 2,
      colCount: 2,
      hidden: false,
      cells: [
        {
          row: 0,
          col: 0,
          address: "A1",
          value: "Metric & status",
          rawValue: "Metric & status",
          style: { bold: true, fillColor: "#FFF2CC", textColor: "#1F4E79" },
        },
        {
          row: 0,
          col: 1,
          address: "B1",
          value: "Value",
          rawValue: "Value",
        },
        {
          row: 1,
          col: 0,
          address: "A2",
          value: "Revenue",
          rawValue: "Revenue",
        },
        {
          row: 1,
          col: 1,
          address: "B2",
          value: "25",
          rawValue: 25,
          formula: "SUM(10,15)",
          style: { italic: true, fontSize: 12, numberFormat: "$0.00" },
        },
      ],
      mergedCells: [{ ref: "A1:B1", startRow: 0, startCol: 0, endRow: 0, endCol: 1 }],
      columnWidths: [{ col: 0, widthChars: 18 }],
      tables: [{ name: "Metrics", ref: "A1:B2", startRow: 0, startCol: 0, endRow: 1, endCol: 1 }],
      charts: [{ id: "chart1", title: "Revenue <Plan>", type: "bar" }],
    },
  ],
};

describe("Univer spreadsheet helpers", () => {
  test("builds XML prompt context from Univer selection and escapes user content", () => {
    const data = spreadsheetSnapshotToUniverData(WORKBOOK);
    const selection = selectionContextFromWorkbook(
      WORKBOOK,
      data,
      "Summary",
      { startRow: 0, startColumn: 0, endRow: 1, endColumn: 1 },
      "B2",
    );

    const prompt = buildUniverSpreadsheetPrompt({
      path: WORKBOOK.path,
      workbook: WORKBOOK,
      selection,
      request: 'what do you think of "margin" & <growth>?',
    });

    expect(prompt).toContain('<spreadsheet_canvas_request version="2" source="univer">');
    expect(prompt).toContain('mode="answer_without_editing"');
    expect(prompt).toContain('<selection range="A1:B2" active_cell="B2">');
    expect(prompt).toContain("<formula>=SUM(10,15)</formula>");
    expect(prompt).toContain('title="Revenue &lt;Plan&gt;"');
    expect(prompt).toContain("what do you think of &quot;margin&quot; &amp; &lt;growth&gt;?");
  });

  test("selection context uses live Univer style and formula state", () => {
    const data = spreadsheetSnapshotToUniverData(WORKBOOK);
    const sheet = data.sheets["sheet-1"];
    expect(sheet).toBeDefined();
    if (!sheet) return;
    sheet.cellData = {
      ...sheet.cellData,
      1: {
        ...sheet.cellData?.[1],
        1: {
          v: 50,
        },
      },
    };

    const selection = selectionContextFromWorkbook(WORKBOOK, data, "Summary", null, "B2");

    expect(selection?.activeValue).toBe("50");
    expect(selection?.activeFormula).toBeUndefined();
    expect(selection?.activeStyle).toBeUndefined();
  });

  test("selection context treats cleared live cells as empty", () => {
    const data = spreadsheetSnapshotToUniverData(WORKBOOK);
    const sheet = data.sheets["sheet-1"];
    expect(sheet).toBeDefined();
    if (!sheet) return;
    const row = { ...sheet.cellData?.[1] };
    delete row[1];
    sheet.cellData = {
      ...sheet.cellData,
      1: row,
    };

    const selection = selectionContextFromWorkbook(WORKBOOK, data, "Summary", null, "B2");

    expect(selection?.activeValue).toBe("");
    expect(selection?.activeFormula).toBeUndefined();
    expect(selection?.activeStyle).toBeUndefined();
  });

  test("rebuilds prompt selection from a refreshed workbook snapshot", () => {
    const selection = selectionContextFromSnapshot(
      {
        ...WORKBOOK,
        fileVersion: { modifiedAtMs: 2, changeTimeMs: 2, size: 2, fingerprint: "2:2:2" },
        sheets: [
          {
            ...WORKBOOK.sheets[0]!,
            cells: [
              ...WORKBOOK.sheets[0]!.cells.filter((cell) => cell.address !== "B2"),
              {
                row: 1,
                col: 1,
                address: "B2",
                value: "99",
                rawValue: 99,
                formula: "SUM(40,59)",
                style: { bold: true },
              },
            ],
          },
        ],
      },
      {
        sheetName: "Summary",
        rangeA1: "A1:B2",
        activeCellA1: "B2",
        activeValue: "25",
        activeFormula: "=SUM(10,15)",
        activeStyle: { italic: true },
      },
    );

    expect(selection).toEqual({
      sheetName: "Summary",
      rangeA1: "A1:B2",
      activeCellA1: "B2",
      activeValue: "99",
      activeFormula: "=SUM(40,59)",
      activeStyle: { bold: true },
    });
  });

  test("uses CSV display text instead of coerced raw values", () => {
    const data = spreadsheetSnapshotToUniverData({
      ...WORKBOOK,
      kind: "csv",
      filename: "data.csv",
      path: "/workspace/data.csv",
      sheets: [
        {
          ...WORKBOOK.sheets[0]!,
          cells: [
            {
              row: 0,
              col: 0,
              address: "A1",
              value: "001",
              rawValue: 1,
            },
            {
              row: 0,
              col: 1,
              address: "B1",
              value: "TRUE",
              rawValue: true,
            },
          ],
        },
      ],
    });

    expect(data.sheets["sheet-1"]?.cellData?.[0]?.[0]?.v).toBe("001");
    expect(data.sheets["sheet-1"]?.cellData?.[0]?.[0]?.t).toBe(CellValueType.STRING);
    expect(data.sheets["sheet-1"]?.cellData?.[0]?.[1]?.v).toBe("TRUE");
    expect(data.sheets["sheet-1"]?.cellData?.[0]?.[1]?.t).toBe(CellValueType.STRING);
  });

  test("uses XLSX error display text instead of raw error codes", () => {
    const data = spreadsheetSnapshotToUniverData({
      ...WORKBOOK,
      sheets: [
        {
          ...WORKBOOK.sheets[0]!,
          cells: [
            {
              row: 0,
              col: 0,
              address: "A1",
              value: "#DIV/0!",
              formattedValue: "#DIV/0!",
              rawValue: 7,
              type: "e",
            },
          ],
        },
      ],
    });

    expect(data.sheets["sheet-1"]?.cellData?.[0]?.[0]?.v).toBe("#DIV/0!");
    expect(data.sheets["sheet-1"]?.cellData?.[0]?.[0]?.t).toBe(CellValueType.STRING);
  });

  test("caps truncated sheets to loaded snapshot bounds", () => {
    const data = spreadsheetSnapshotToUniverData({
      ...WORKBOOK,
      warnings: ["Summary: workbook canvas snapshot is limited"],
      sheets: [
        {
          ...WORKBOOK.sheets[0]!,
          rowCount: 10_000,
          colCount: 250,
          loadedRowCount: 200,
          loadedColCount: 25,
          truncatedRows: true,
          truncatedCols: true,
          cells: [],
          mergedCells: [],
          columnWidths: [],
          tables: [],
          charts: [],
        },
      ],
    });

    expect(data.sheets["sheet-1"]?.rowCount).toBe(200);
    expect(data.sheets["sheet-1"]?.columnCount).toBe(25);
  });

  test("diffs Univer workbook edits into value and format batch operations", () => {
    const previous = spreadsheetSnapshotToUniverData(WORKBOOK);
    const current = cloneUniverWorkbookData(previous);
    const sheet = current.sheets["sheet-1"];
    expect(sheet).toBeDefined();
    if (!sheet) return;

    sheet.cellData = {
      ...sheet.cellData,
      1: {
        ...sheet.cellData?.[1],
        1: {
          ...(sheet.cellData?.[1]?.[1] ?? {}),
          f: "=SUM(20,30)",
          v: 50,
          s: "changed-style",
        },
      },
    };
    current.styles["changed-style"] = {
      bl: BooleanNumber.TRUE,
      it: BooleanNumber.TRUE,
      fs: 14,
      bg: { rgb: "#FFF2CC" },
      cl: { rgb: "#1F4E79" },
      n: { pattern: "0.0%" },
      ht: HorizontalAlign.CENTER,
    };
    sheet.mergeData = [{ startRow: 1, startColumn: 0, endRow: 1, endColumn: 1 }];

    expect(diffUniverWorkbookPatches(previous, current)).toEqual([
      {
        type: "cell",
        sheetName: "Summary",
        address: "B2",
        rawInput: "=SUM(20,30)",
      },
      {
        type: "format",
        sheetName: "Summary",
        range: "B2",
        style: {
          bold: true,
          fillColor: "#FFF2CC",
          fontSize: 14,
          horizontalAlign: "center",
          numberFormat: "0.0%",
          textColor: "#1F4E79",
        },
      },
      {
        type: "merge",
        sheetName: "Summary",
        range: "A1:B1",
        merged: false,
      },
      {
        type: "merge",
        sheetName: "Summary",
        range: "A2:B2",
        merged: true,
      },
    ]);
  });

  test("diffs column width changes for XLSX save batches", () => {
    const previous = spreadsheetSnapshotToUniverData(WORKBOOK);
    const current = cloneUniverWorkbookData(previous);
    const sheet = current.sheets["sheet-1"];
    expect(sheet).toBeDefined();
    if (!sheet) return;

    sheet.columnData = {
      ...sheet.columnData,
      0: { w: 220 },
    };

    expect(diffUniverWorkbookPatches(previous, current)).toContainEqual({
      type: "columnWidth",
      sheetName: "Summary",
      col: 0,
      widthPx: 220,
    });
  });

  test("diffs column width resets for XLSX save batches", () => {
    const previous = spreadsheetSnapshotToUniverData(WORKBOOK);
    const current = cloneUniverWorkbookData(previous);
    const sheet = current.sheets["sheet-1"];
    expect(sheet).toBeDefined();
    if (!sheet) return;

    sheet.columnData = {};

    expect(diffUniverWorkbookPatches(previous, current)).toContainEqual({
      type: "columnWidth",
      sheetName: "Summary",
      col: 0,
      widthPx: null,
    });
  });

  test("omits unsupported formatting changes when diffing CSV workbooks", () => {
    const previous = spreadsheetSnapshotToUniverData(WORKBOOK);
    const current = cloneUniverWorkbookData(previous);
    const sheet = current.sheets["sheet-1"];
    expect(sheet).toBeDefined();
    if (!sheet) return;

    sheet.cellData = {
      ...sheet.cellData,
      1: {
        ...sheet.cellData?.[1],
        1: {
          ...(sheet.cellData?.[1]?.[1] ?? {}),
          f: "=SUM(20,30)",
          s: "changed-style",
        },
      },
    };
    current.styles["changed-style"] = { bl: BooleanNumber.TRUE };
    sheet.mergeData = [{ startRow: 1, startColumn: 0, endRow: 1, endColumn: 1 }];
    sheet.columnData = { ...sheet.columnData, 0: { w: 220 } };

    expect(diffUniverWorkbookPatches(previous, current, { includeFormatting: false })).toEqual([
      {
        type: "cell",
        sheetName: "Summary",
        address: "B2",
        rawInput: "=SUM(20,30)",
      },
    ]);
  });
});
