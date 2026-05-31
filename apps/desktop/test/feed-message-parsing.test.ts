import { describe, expect, test } from "bun:test";

import type { SpreadsheetWorkbookSnapshot } from "../../../src/shared/spreadsheetPreview";
import { buildCanvasDocumentPrompt } from "../src/lib/canvasRequest";
import {
  buildUniverSpreadsheetPrompt,
  selectionContextFromWorkbook,
  spreadsheetSnapshotToUniverData,
} from "../src/lib/univerSpreadsheet";
import { parseCanvasRequest } from "../src/ui/chat/feedMessageParsing";

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

describe("parseCanvasRequest", () => {
  test("parses the spreadsheet envelope with file, sheet, region, and unescaped request", () => {
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

    const parsed = parseCanvasRequest(prompt);
    expect(parsed).not.toBeNull();
    expect(parsed?.surface).toBe("spreadsheet");
    expect(parsed?.fileName).toBe("Q3 & Q4.xlsx");
    expect(parsed?.fileKind).toBe("xlsx");
    expect(parsed?.sheet).toBe("Dashboard <main>");
    expect(parsed?.region).toBe("A1:B1");
    expect(parsed?.selectionText).toBe("Revenue & growth");
    expect(parsed?.userRequest).toBe('highlight "A1" & make it bold');
  });

  test("parses the document envelope round-tripped through buildCanvasDocumentPrompt", () => {
    const prompt = buildCanvasDocumentPrompt({
      path: "/workspace/notes & ideas.md",
      fileName: "notes & ideas.md",
      kind: "markdown",
      selection: 'The "old" intro <paragraph>',
      request: "tighten this up & fix grammar",
    });

    const parsed = parseCanvasRequest(prompt);
    expect(parsed).not.toBeNull();
    expect(parsed?.surface).toBe("document");
    expect(parsed?.fileName).toBe("notes & ideas.md");
    expect(parsed?.fileKind).toBe("markdown");
    expect(parsed?.sheet).toBeNull();
    expect(parsed?.region).toBeNull();
    expect(parsed?.selectionText).toBe('The "old" intro <paragraph>');
    expect(parsed?.userRequest).toBe("tighten this up & fix grammar");
  });

  test("omits the selection when the document canvas has no active selection", () => {
    const prompt = buildCanvasDocumentPrompt({
      path: "/w/readme.md",
      fileName: "readme.md",
      kind: "markdown",
      selection: null,
      request: "add a quickstart section",
    });

    expect(prompt).not.toContain("<selection>");
    const parsed = parseCanvasRequest(prompt);
    expect(parsed?.selectionText).toBeNull();
    expect(parsed?.userRequest).toBe("add a quickstart section");
  });

  test("keeps feedback-mode instructions consistent across canvas surfaces", () => {
    const feedbackRequest = "what do you think about this?";
    const feedbackInstruction =
      "The user is asking for feedback or analysis; answer directly unless they explicitly ask for file changes.";
    const documentPrompt = buildCanvasDocumentPrompt({
      path: "/w/readme.md",
      fileName: "readme.md",
      kind: "markdown",
      selection: null,
      request: feedbackRequest,
    });
    const spreadsheetPrompt = buildUniverSpreadsheetPrompt({
      path: WORKBOOK.path,
      workbook: WORKBOOK,
      selection: null,
      request: feedbackRequest,
    });

    expect(documentPrompt).toContain('mode="answer_without_editing"');
    expect(spreadsheetPrompt).toContain('mode="answer_without_editing"');
    expect(documentPrompt).toContain(feedbackInstruction);
    expect(spreadsheetPrompt).toContain(feedbackInstruction);
  });

  test("parses the legacy [Canvas Collaborative Edit] markdown envelope", () => {
    const legacy = [
      "[Canvas Collaborative Edit]",
      "Please edit the file `plan.md` (located at `/w/plan.md`) based on my instructions below.",
      "",
      "**Instructions:**",
      "make the tone friendlier",
      "",
      "**Target Section / Selection:**",
      "> Welcome to the project.",
    ].join("\n");

    const parsed = parseCanvasRequest(legacy);
    expect(parsed?.surface).toBe("document");
    expect(parsed?.fileName).toBe("plan.md");
    expect(parsed?.selectionText).toBe("Welcome to the project.");
    expect(parsed?.userRequest).toBe("make the tone friendlier");
  });

  test("returns null for ordinary user messages", () => {
    expect(parseCanvasRequest("just a normal question")).toBeNull();
    expect(parseCanvasRequest("<not_a_canvas>hi</not_a_canvas>")).toBeNull();
  });
});
