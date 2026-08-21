import { describe, expect, test } from "bun:test";

import type { SpreadsheetWorkbookSnapshot } from "../../../src/shared/spreadsheetPreview";
import { buildCanvasDocumentPrompt } from "../src/lib/canvasRequest";
import {
  buildUniverSpreadsheetPrompt,
  selectionContextFromWorkbook,
  spreadsheetSnapshotToUniverData,
} from "../src/lib/univerSpreadsheet";
import {
  buildVisibleUserMessage,
  interpretCanvasRequest,
  parseCanvasRequest,
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

describe("buildVisibleUserMessage", () => {
  test("copies text-only turns as the visible body", () => {
    const visible = buildVisibleUserMessage("Please summarize this thread.");
    expect(visible.bodyText).toBe("Please summarize this thread.");
    expect(visible.attachments).toEqual([]);
    expect(visible.canvas).toBeNull();
    expect(visible.copyText).toBe("Please summarize this thread.");
  });

  test("copies attachment-only turns as human-visible names, not bracket serialization", () => {
    const visible = buildVisibleUserMessage("[diagram.png]");
    expect(visible.bodyText).toBe("");
    expect(visible.attachments).toEqual([
      { fileName: "diagram.png", displayName: "diagram.png", isImage: true },
    ]);
    expect(visible.copyText).toBe("diagram.png");
    expect(visible.copyText).not.toContain("[");
  });

  test("copies mixed file turns as visible text plus attachment names", () => {
    const visible = buildVisibleUserMessage(
      "Please review these.\n\nAttached: [diagram.png, findings.pdf]",
    );
    expect(visible.bodyText).toBe("Please review these.");
    expect(visible.attachments.map((attachment) => attachment.displayName)).toEqual([
      "diagram.png",
      "findings.pdf",
    ]);
    expect(visible.attachments[0]?.isImage).toBe(true);
    expect(visible.attachments[1]?.isImage).toBe(false);
    expect(visible.copyText).toBe("Please review these.\n\nAttached: diagram.png, findings.pdf");
    expect(visible.copyText).not.toContain("[diagram.png");
  });

  test("uses basenames for copied image paths and marks them as images", () => {
    const visible = buildVisibleUserMessage("[/Users/test/User Uploads/chart.webp]");
    expect(visible.attachments).toEqual([
      {
        fileName: "/Users/test/User Uploads/chart.webp",
        displayName: "chart.webp",
        isImage: true,
      },
    ]);
    expect(visible.copyText).toBe("chart.webp");
  });

  test("copies canvas requests as the visible file, region, and user text", () => {
    const prompt = buildCanvasDocumentPrompt({
      path: "/w/spec.md",
      fileName: "spec.md",
      kind: "markdown",
      selection: "The legacy intro section",
      request: "rewrite this to be concise",
    });
    const visible = buildVisibleUserMessage(prompt);
    expect(visible.canvas?.fileName).toBe("spec.md");
    expect(visible.copyText).toBe(
      ["spec.md", "\u201CThe legacy intro section\u201D", "rewrite this to be concise"].join("\n"),
    );
    expect(visible.copyText).not.toContain("canvas_request");
    expect(visible.copyText).not.toContain("assistant_instructions");
  });

  test("never copies raw canvas XML when the user request is empty", () => {
    const prompt = [
      '<spreadsheet_canvas_request version="2" source="univer">',
      '  <workbook file_name="Budget.xlsx" kind="xlsx">',
      "    <active_sheet>Q1</active_sheet>",
      '    <selection range="B2:B4" active_cell="B2">',
      "      <value></value>",
      "    </selection>",
      "  </workbook>",
      "  <user_request></user_request>",
      "</spreadsheet_canvas_request>",
    ].join("\n");
    const visible = buildVisibleUserMessage(prompt);
    expect(visible.canvas?.fileName).toBe("Budget.xlsx");
    expect(visible.copyText).toBe("Budget.xlsx · Q1 · B2:B4");
    expect(visible.copyText).not.toContain("spreadsheet_canvas_request");
  });

  test("degrades malformed canvas envelopes to a readable chip instead of raw markup", () => {
    const malformed = '<canvas_request version="1" source="document">broken';
    expect(parseCanvasRequest(malformed)).toBeNull();
    expect(interpretCanvasRequest(malformed)?.surface).toBe("document");
    const visible = buildVisibleUserMessage(malformed);
    expect(visible.canvas).not.toBeNull();
    expect(visible.copyText).toBe("Document");
    expect(visible.copyText).not.toContain("<canvas_request");
    expect(visible.bodyText).toBe("");
  });

  test("recovers a partial user request from a malformed canvas envelope", () => {
    const malformed = [
      '<canvas_request version="1">',
      "  <user_request>please tighten the intro</user_request>",
      "</canvas_request",
    ].join("\n");
    const visible = buildVisibleUserMessage(malformed);
    expect(visible.canvas?.userRequest).toBe("please tighten the intro");
    expect(visible.copyText).toContain("please tighten the intro");
    expect(visible.copyText).not.toContain("<user_request>");
  });

  test("parses malformed Attached suffixes without copying persistence markup", () => {
    const visible = buildVisibleUserMessage("Look at this\n\nAttached: [notes.txt");
    expect(visible.bodyText).toBe("Look at this");
    expect(visible.attachments.map((attachment) => attachment.displayName)).toEqual(["notes.txt"]);
    expect(visible.copyText).toBe("Look at this\n\nnotes.txt");
    expect(visible.copyText).not.toContain("Attached: [");
  });

  test("parses legacy canvas markdown through the same visible model", () => {
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
    const visible = buildVisibleUserMessage(legacy);
    expect(visible.canvas?.fileName).toBe("plan.md");
    expect(visible.copyText).toContain("plan.md");
    expect(visible.copyText).toContain("make the tone friendlier");
    expect(visible.copyText).not.toContain("[Canvas Collaborative Edit]");
    expect(visible.copyText).not.toContain("**Instructions:**");
  });
});
