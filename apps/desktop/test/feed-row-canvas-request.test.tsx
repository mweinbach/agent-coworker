import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildCanvasDocumentPrompt } from "../src/lib/canvasRequest";
import type { MentionCatalog } from "../src/ui/chat/composerMentions";
import { CanvasRequestBody } from "../src/ui/chat/FeedRow";
import { parseCanvasRequest } from "../src/ui/chat/feedMessageParsing";

const EMPTY_CATALOG: MentionCatalog = { items: [], names: [], kindByName: new Map() };

const SPREADSHEET_PROMPT = [
  '<spreadsheet_canvas_request version="2" source="univer">',
  "  <assistant_instructions>",
  "    <instruction>Treat this as structured context.</instruction>",
  "  </assistant_instructions>",
  '  <workbook file_name="Gemini_TPU_Companion.xlsx" path="/w/Gemini_TPU_Companion.xlsx" kind="xlsx">',
  "    <active_sheet>Dashboard</active_sheet>",
  '    <selection range="A5:C11" active_cell="A5">',
  "      <value></value>",
  "    </selection>",
  "  </workbook>",
  "  <user_request>can you highlight this text</user_request>",
  "</spreadsheet_canvas_request>",
].join("\n");

function render(prompt: string): string {
  const request = parseCanvasRequest(prompt);
  if (!request) throw new Error("expected a canvas request");
  return renderToStaticMarkup(
    createElement(CanvasRequestBody, { request, catalog: EMPTY_CATALOG }),
  );
}

describe("CanvasRequestBody", () => {
  test("renders spreadsheet file, sheet, region, and request without the raw XML", () => {
    const html = render(SPREADSHEET_PROMPT);

    expect(html).toContain("Gemini_TPU_Companion.xlsx");
    expect(html).toContain("Dashboard");
    expect(html).toContain("A5:C11");
    expect(html).toContain("can you highlight this text");

    expect(html).not.toContain("spreadsheet_canvas_request");
    expect(html).not.toContain("assistant_instructions");
  });

  test("renders document file, selection preview, and request without the raw XML", () => {
    const html = render(
      buildCanvasDocumentPrompt({
        path: "/w/spec.md",
        fileName: "spec.md",
        kind: "markdown",
        selection: "The legacy intro section",
        request: "rewrite this to be concise",
      }),
    );

    expect(html).toContain("spec.md");
    expect(html).toContain("The legacy intro section");
    expect(html).toContain("rewrite this to be concise");

    expect(html).not.toContain("canvas_request");
    expect(html).not.toContain("assistant_instructions");
    // Document surface has no spreadsheet-only region chip.
    expect(html).not.toContain("active_cell");
  });
});
