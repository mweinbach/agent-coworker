import { describe, expect, test } from "bun:test";

import { ASK_SKIP_TOKEN } from "../src/lib/wsProtocol";
import { formatToolCard } from "../src/ui/chat/toolCards/toolCardFormatting";

describe("tool card formatting ask summaries", () => {
  test("shows skipped summary for ask skip token", () => {
    const out = formatToolCard(
      "ask",
      { question: "What do you want?" },
      { answer: ASK_SKIP_TOKEN },
      "output-available",
    );
    expect(out.subtitle).toContain("Skipped");
  });

  test("shows rejected summary for empty ask answer", () => {
    const out = formatToolCard(
      "ask",
      { question: "What do you want?" },
      { answer: "   " },
      "output-available",
    );
    expect(out.subtitle).toContain("No answer (rejected)");
  });

  test("shows answer preview for non-empty ask answer", () => {
    const out = formatToolCard(
      "ask",
      { question: "What do you want?" },
      { answer: "Spreadsheet" },
      "output-available",
    );
    expect(out.subtitle).toContain("Answer: Spreadsheet");
  });

  test("renders native web search cards with a generic web search title", () => {
    const out = formatToolCard(
      "nativeWebSearch",
      { action: { type: "search", query: "latest OpenAI" } },
      { action: { type: "search", query: "latest OpenAI" } },
      "output-available",
    );
    expect(out.title).toBe("Web Search");
    expect(out.subtitle).toContain("Search: latest OpenAI");
  });

  test("renders running native web search cards from Codex action args", () => {
    const out = formatToolCard(
      "nativeWebSearch",
      { action: { type: "search", query: "LGA crash 2026" } },
      undefined,
      "input-streaming",
    );
    expect(out.title).toBe("Web Search");
    expect(out.subtitle).toContain("Search: LGA crash 2026");
  });

  test("keeps backward compatibility for bare native web search action args", () => {
    const out = formatToolCard(
      "nativeWebSearch",
      { type: "open_page", url: "https://example.com/article" },
      undefined,
      "input-streaming",
    );
    expect(out.subtitle).toContain("Opened: https://example.com/article");
  });

  test("renders Google native web search cards from query arrays", () => {
    const out = formatToolCard(
      "nativeWebSearch",
      { queries: ["LaGuardia airport March 22 2026"] },
      undefined,
      "input-streaming",
    );
    expect(out.title).toBe("Web Search");
    expect(out.subtitle).toContain("Search: LaGuardia airport March 22 2026");
  });

  test("renders native URL context cards with URL-specific summaries", () => {
    const out = formatToolCard(
      "nativeUrlContext",
      { urls: ["https://example.com/about"] },
      {
        provider: "google",
        urls: ["https://example.com/about"],
        results: [{ url: "https://example.com/about", status: "success" }],
      },
      "output-available",
    );
    expect(out.title).toBe("URL Context");
    expect(out.subtitle).toContain("Read: https://example.com/about");
  });

  test("labels spawnAgent rows by nickname and role while running", () => {
    const out = formatToolCard(
      "spawnAgent",
      { nickname: "ntia-scout", role: "research", message: "Find NTIA reports" },
      undefined,
      "input-available",
    );
    expect(out.title).toBe("Spawn Agent");
    expect(out.subtitle).toBe("ntia-scout · research");
    expect(out.subtitle).not.toContain("Running");
  });

  test("summarizes waitForAgent by agent count", () => {
    const out = formatToolCard(
      "waitForAgent",
      {
        agentIds: ["a", "b", "c", "d"],
        mode: "all",
      },
      undefined,
      "input-available",
    );
    expect(out.title).toBe("Wait for Agents");
    expect(out.subtitle).toBe("Waiting for 4 agents");
  });

  test("summarizes modern todoWrite args without a generic Completed suffix", () => {
    const out = formatToolCard(
      "todoWrite",
      {
        todos: [
          { content: "Research", status: "completed" },
          { content: "Synthesize", status: "completed" },
          { content: "Write PDF", status: "in_progress" },
          { content: "Verify", status: "pending" },
        ],
      },
      "ok",
      "output-available",
    );
    expect(out.title).toBe("Todo Write");
    expect(out.subtitle).toBe("1 active · 2 complete · 1 pending");
    expect(out.subtitle).not.toContain("Completed");
  });

  test("preserves basenames when truncating long Windows paths", () => {
    const longPath =
      "C:\\Users\\maxw6\\.cowork\\chats\\20260726T202054Z-use-a-workflow-and-do-research-into-kimi-b4\\research\\kimi-k3.md";
    const out = formatToolCard("read", { filePath: longPath }, "file contents", "output-available");
    expect(out.subtitle).toContain("kimi-k3.md");
    expect(out.subtitle).not.toContain("Completed");
    expect(out.subtitle.length).toBeLessThan(longPath.length);
  });
});
