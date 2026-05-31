import { describe, expect, test } from "bun:test";
import { BooleanNumber, HorizontalAlign } from "@univerjs/core";

import type { SpreadsheetWorkbookSnapshot } from "../../../src/shared/spreadsheetPreview";
import {
  buildUniverSpreadsheetPrompt,
  cloneUniverWorkbookData,
  diffUniverWorkbookPatches,
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
      ht: HorizontalAlign.CENTER,
    };

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
          textColor: "#1F4E79",
        },
      },
    ]);
  });
});
