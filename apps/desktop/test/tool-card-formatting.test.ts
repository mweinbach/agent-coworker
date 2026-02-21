import { describe, expect, test } from "bun:test";

import { ASK_SKIP_TOKEN } from "../src/lib/wsProtocol";
import { formatToolCard } from "../src/ui/chat/toolCards/toolCardFormatting";

describe("tool card formatting ask summaries", () => {
  test("shows skipped summary for ask skip token", () => {
    const out = formatToolCard("ask", { question: "What do you want?" }, { answer: ASK_SKIP_TOKEN }, "done");
    expect(out.subtitle).toContain("Skipped");
  });

  test("shows rejected summary for empty ask answer", () => {
    const out = formatToolCard("ask", { question: "What do you want?" }, { answer: "   " }, "done");
    expect(out.subtitle).toContain("No answer (rejected)");
  });

  test("shows answer preview for non-empty ask answer", () => {
    const out = formatToolCard("ask", { question: "What do you want?" }, { answer: "Spreadsheet" }, "done");
    expect(out.subtitle).toContain("Answer: Spreadsheet");
  });
});
