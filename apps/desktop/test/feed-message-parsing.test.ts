import { describe, expect, test } from "bun:test";

import type { SpreadsheetWorkbookSnapshot } from "../../../src/shared/spreadsheetPreview";
import {
  buildUniverSpreadsheetPrompt,
  selectionContextFromWorkbook,
  spreadsheetSnapshotToUniverData,
} from "../src/lib/univerSpreadsheet";
import {
  parseCanvasEditMessage,
  parseSpreadsheetCanvasRequest,
} from "../src/ui/chat/feedMessageParsing";

const WORKBOOK: SpreadsheetWorkbookSnapshot = {
  kind: "xlsx",
  path: "/workspace/Q3 & Q4.xlsx",
  filename: "Q3 & Q4.xlsx",
  fileVersion: { modifiedAtMs: 1, changeTimeMs: 1, size: 1, fingerprint: "1:1:1" },
  activeSheetName: "Dashboard <main>",
  warnings: [],
  sheets: [
    {
      id: "sheet-1",
      name: "Dashboard <main>",
      rowCount: 2,
      colCount: 2,
      hidden: false,
      cells: [
        {
          row: 0,
          col: 0,
          address: "A1",
          value: "Revenue & growth",
          rawValue: "Revenue & growth",
        },
        { row: 0, col: 1, address: "B1", value: "Value", rawValue: "Value" },
      ],
      mergedCells: [],
      columnWidths: [],
      tables: [],
      charts: [],
    },
  ],
};

describe("parseSpreadsheetCanvasRequest", () => {
  test("extracts file, sheet, region, and unescaped request from the canvas envelope", () => {
    const data = spreadsheetSnapshotToUniverData(WORKBOOK);
    const selection = selectionContextFromWorkbook(
      WORKBOOK,
      data,
      "Dashboard <main>",
      { startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 },
      "A1",
    );

    const prompt = buildUniverSpreadsheetPrompt({
      path: WORKBOOK.path,
      workbook: WORKBOOK,
      selection,
      request: 'highlight "A1" & make it bold',
    });

    const parsed = parseSpreadsheetCanvasRequest(prompt);
    expect(parsed).not.toBeNull();
    expect(parsed?.fileName).toBe("Q3 & Q4.xlsx");
    expect(parsed?.kind).toBe("xlsx");
    expect(parsed?.sheet).toBe("Dashboard <main>");
    expect(parsed?.selectionRange).toBe("A1:B1");
    expect(parsed?.activeCell).toBe("A1");
    expect(parsed?.value).toBe("Revenue & growth");
    expect(parsed?.userRequest).toBe('highlight "A1" & make it bold');
  });

  test("returns null for plain user messages and legacy canvas-edit messages", () => {
    expect(parseSpreadsheetCanvasRequest("just a normal question")).toBeNull();
    expect(
      parseSpreadsheetCanvasRequest(
        "[Open Canvas Collaborative Edit]\n\n**Instructions:**\nrewrite this",
      ),
    ).toBeNull();
    // The legacy parser still handles its own format.
    expect(
      parseCanvasEditMessage("[Open Canvas Collaborative Edit]\n\n**Instructions:**\nrewrite this")
        ?.instructions,
    ).toBe("rewrite this");
  });

  test("tolerates an empty selection value", () => {
    const prompt = [
      '<spreadsheet_canvas_request version="2" source="univer">',
      '  <workbook file_name="model.xlsx" path="/w/model.xlsx" kind="xlsx">',
      "    <active_sheet>Sheet1</active_sheet>",
      '    <selection range="A5:C11" active_cell="A5">',
      "      <value></value>",
      "    </selection>",
      "  </workbook>",
      "  <user_request>can you highlight this text</user_request>",
      "</spreadsheet_canvas_request>",
    ].join("\n");

    const parsed = parseSpreadsheetCanvasRequest(prompt);
    expect(parsed?.value).toBeNull();
    expect(parsed?.selectionRange).toBe("A5:C11");
    expect(parsed?.userRequest).toBe("can you highlight this text");
  });
});
