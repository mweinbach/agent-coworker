import { describe, expect, test } from "bun:test";

import { ASK_SKIP_TOKEN } from "../src/lib/wsProtocol";
import { formatToolCard } from "../src/ui/chat/toolCards/toolCardFormatting";

describe("tool card formatting ask summaries", () => {
  test("shows skipped summary for ask skip token", () => {
    const out = formatToolCard("ask", { question: "What do you want?" }, { answer: ASK_SKIP_TOKEN }, "output-available");
    expect(out.subtitle).toContain("Skipped");
  });

  test("shows rejected summary for empty ask answer", () => {
    const out = formatToolCard("ask", { question: "What do you want?" }, { answer: "   " }, "output-available");
    expect(out.subtitle).toContain("No answer (rejected)");
  });

  test("shows answer preview for non-empty ask answer", () => {
    const out = formatToolCard("ask", { question: "What do you want?" }, { answer: "Spreadsheet" }, "output-available");
    expect(out.subtitle).toContain("Answer: Spreadsheet");
  });

  test("renders native web search cards with a generic web search title", () => {
    const out = formatToolCard(
      "nativeWebSearch",
      { action: { type: "search", query: "latest OpenAI" } },
      { action: { type: "search", query: "latest OpenAI" } },
      "output-available"
    );
    expect(out.title).toBe("Web Search");
    expect(out.subtitle).toContain("Search: latest OpenAI");
  });

  test("renders running native web search cards from Codex action args", () => {
    const out = formatToolCard(
      "nativeWebSearch",
      { action: { type: "search", query: "LGA crash 2026" } },
      undefined,
      "input-streaming"
    );
    expect(out.title).toBe("Web Search");
    expect(out.subtitle).toContain("Search: LGA crash 2026");
  });

  test("keeps backward compatibility for bare native web search action args", () => {
    const out = formatToolCard(
      "nativeWebSearch",
      { type: "open_page", url: "https://example.com/article" },
      undefined,
      "input-streaming"
    );
    expect(out.subtitle).toContain("Opened: https://example.com/article");
  });

  test("renders Google native web search cards from query arrays", () => {
    const out = formatToolCard(
      "nativeWebSearch",
      { queries: ["LaGuardia airport March 22 2026"] },
      undefined,
      "input-streaming"
    );
    expect(out.title).toBe("Web Search");
    expect(out.subtitle).toContain("Search: LaGuardia airport March 22 2026");
  });

  test("renders native URL context cards with URL-specific summaries", () => {
    const out = formatToolCard(
      "nativeUrlContext",
      { urls: ["https://example.com/about"] },
      { provider: "google", urls: ["https://example.com/about"], results: [{ url: "https://example.com/about", status: "success" }] },
      "output-available"
    );
    expect(out.title).toBe("URL Context");
    expect(out.subtitle).toContain("Read: https://example.com/about");
  });

});
