import { describe, expect, test } from "bun:test";

import { buildCanvasDocumentPrompt } from "../src/lib/canvasRequest";
import {
  buildVisibleUserMessage,
  interpretCanvasRequest,
  parseCanvasRequest,
} from "../src/ui/chat/feedMessageParsing";

describe("visible user-message parse edges", () => {
  test("uses the active cell when a spreadsheet envelope has an empty range", () => {
    const prompt = [
      '<spreadsheet_canvas_request version="2" source="univer">',
      '  <workbook file_name="Budget.xlsx" kind="xlsx">',
      "    <active_sheet>Q1</active_sheet>",
      '    <selection range="" active_cell="B2">',
      "      <value>42</value>",
      "    </selection>",
      "  </workbook>",
      "  <user_request>explain this cell</user_request>",
      "</spreadsheet_canvas_request>",
    ].join("\n");

    const parsed = parseCanvasRequest(prompt);
    expect(parsed?.region).toBe("B2");
    expect(parsed?.selectionText).toBe("42");
    expect(buildVisibleUserMessage(prompt).copyText).toBe(
      ["Budget.xlsx · Q1 · B2", "\u201C42\u201D", "explain this cell"].join("\n"),
    );
  });

  test("recovers a malformed spreadsheet envelope instead of copying raw XML", () => {
    const malformed = [
      '<spreadsheet_canvas_request version="2">',
      '  <workbook file_name="Ledger.xlsx" kind="xlsx"></workbook>',
      "  broken",
    ].join("\n");

    expect(parseCanvasRequest(malformed)).toBeNull();
    expect(interpretCanvasRequest(malformed)).toMatchObject({
      surface: "spreadsheet",
      fileName: "Ledger.xlsx",
      userRequest: "",
    });
    const visible = buildVisibleUserMessage(malformed);
    expect(visible.copyText).toBe("Ledger.xlsx");
    expect(visible.copyText).not.toContain("spreadsheet_canvas_request");
  });

  test("copies canvas text plus attachment names without persistence markup", () => {
    const prompt = `${buildCanvasDocumentPrompt({
      path: "/w/spec.md",
      fileName: "spec.md",
      kind: "markdown",
      selection: "Intro",
      request: "tighten this",
    })}\n\nAttached: [diagram.png, notes.txt]`;

    const visible = buildVisibleUserMessage(prompt);
    expect(visible.canvas?.fileName).toBe("spec.md");
    expect(visible.attachments.map((attachment) => attachment.displayName)).toEqual([
      "diagram.png",
      "notes.txt",
    ]);
    expect(visible.copyText).toBe(
      ["spec.md", "\u201CIntro\u201D", "tighten this", "", "Attached: diagram.png, notes.txt"].join(
        "\n",
      ),
    );
    expect(visible.copyText).not.toContain("canvas_request");
    expect(visible.copyText).not.toContain("Attached: [");
  });

  test("keeps literal . and .. attachment names instead of inventing a basename", () => {
    const visible = buildVisibleUserMessage("[., .., /tmp/ok.png]");
    expect(visible.attachments.map((attachment) => attachment.displayName)).toEqual([
      ".",
      "..",
      "ok.png",
    ]);
    expect(visible.copyText).toBe("Attached: ., .., ok.png");
  });

  test("parses canvas envelopes that start with leading whitespace", () => {
    const prompt = `  \n${buildCanvasDocumentPrompt({
      path: "/w/notes.md",
      fileName: "notes.md",
      kind: "markdown",
      selection: null,
      request: "add a summary",
    })}`;

    const visible = buildVisibleUserMessage(prompt);
    expect(visible.canvas?.fileName).toBe("notes.md");
    expect(visible.copyText).toBe("notes.md\nadd a summary");
  });
});
