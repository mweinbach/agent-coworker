import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { MentionCatalog } from "../src/ui/chat/composerMentions";
import { SpreadsheetCanvasRequestBody } from "../src/ui/chat/FeedRow";
import { parseSpreadsheetCanvasRequest } from "../src/ui/chat/feedMessageParsing";

const EMPTY_CATALOG: MentionCatalog = { items: [], names: [], kindByName: new Map() };

const CANVAS_PROMPT = [
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

describe("SpreadsheetCanvasRequestBody", () => {
  test("renders file, sheet, region, and request instead of the raw XML blob", () => {
    const request = parseSpreadsheetCanvasRequest(CANVAS_PROMPT);
    expect(request).not.toBeNull();
    if (!request) return;

    const html = renderToStaticMarkup(
      createElement(SpreadsheetCanvasRequestBody, { request, catalog: EMPTY_CATALOG }),
    );

    expect(html).toContain("Gemini_TPU_Companion.xlsx");
    expect(html).toContain("Dashboard");
    expect(html).toContain("A5:C11");
    expect(html).toContain("can you highlight this text");

    // The raw envelope must never leak into the rendered bubble.
    expect(html).not.toContain("spreadsheet_canvas_request");
    expect(html).not.toContain("assistant_instructions");
    expect(html).not.toContain("&lt;user_request&gt;");
  });
});
