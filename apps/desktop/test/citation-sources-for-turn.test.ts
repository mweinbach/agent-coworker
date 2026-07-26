import { describe, expect, test } from "bun:test";
import type { CitationSource } from "../../../src/shared/displayCitationMarkers";
import type { FeedItem } from "../src/app/types";
import { promoteCitationSourcesToFinalAssistants } from "../src/ui/chat/citationSourcesForTurn";

describe("promoteCitationSourcesToFinalAssistants", () => {
  test("moves mid-turn sources onto the final assistant only", () => {
    const feed: FeedItem[] = [
      {
        id: "u1",
        kind: "message",
        role: "user",
        ts: "2024-01-01T00:00:00.000Z",
        text: "research",
      },
      {
        id: "a1",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:01.000Z",
        text: "Searching…",
      },
      {
        id: "a2",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:02.000Z",
        text: "Here is the final report.",
      },
    ];
    const midSources: CitationSource[] = [
      { url: "https://example.com/a", title: "A" },
      { url: "https://example.com/b", title: "B" },
    ];
    const finalSources: CitationSource[] = [{ url: "https://example.com/c", title: "C" }];
    const input = new Map<string, CitationSource[]>([
      ["a1", midSources],
      ["a2", finalSources],
    ]);

    const promoted = promoteCitationSourcesToFinalAssistants(feed, input);
    expect(promoted.has("a1")).toBe(false);
    expect(promoted.get("a2")?.map((source) => source.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });
});
