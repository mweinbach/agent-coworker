import { describe, expect, test } from "bun:test";
import {
  buildCitationSourcesByMessageId,
  buildCitationUrlsByMessageId,
  type CitationSource,
  normalizeDisplayCitationMarkers,
} from "../../../src/shared/displayCitationMarkers";
import type { FeedItem } from "../src/app/types";
import { promoteCitationSourcesToFinalAssistants } from "../src/ui/chat/citationSourcesForTurn";

describe("promoteCitationSourcesToFinalAssistants", () => {
  test("retains per-message sources and appends earlier sources after final sources", () => {
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
    expect(promoted.get("a1")).toEqual(midSources);
    expect(promoted.get("a2")?.map((source) => source.url)).toEqual([
      "https://example.com/c",
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  test("preserves distinct provider reference aliases for the same source URL", () => {
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
        text: "First citation. citeturn0search0",
      },
      {
        id: "a2",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:02.000Z",
        text: "Final citation. citeturn1search7",
      },
    ];
    const url = "https://example.com/shared";
    const promoted = promoteCitationSourcesToFinalAssistants(
      feed,
      new Map([
        ["a1", [{ url, title: "Earlier source", referenceId: "turn0search0" }]],
        ["a2", [{ url, title: "Final source", referenceId: "turn1search7" }]],
      ]),
    );
    const finalSources = promoted.get("a2") ?? [];

    expect(finalSources.map((source) => source.referenceId)).toEqual([
      "turn1search7",
      "turn0search0",
    ]);
    const rendered = normalizeDisplayCitationMarkers(feed[2]?.text ?? "", {
      citationMode: "html",
      citationUrlsByIndex: new Map([[1, url]]),
      citationSourcesByIndex: new Map(
        finalSources.map((source, index) => [index + 1, source] as const),
      ),
    });
    expect(rendered).toContain("Final source</cite>");
    expect(rendered).toContain('title="__cowork_citation_sources__:');
  });

  test("keeps each assistant citation aligned with its own source and URL indexes", () => {
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
        text: "Earlier citation. citeturn0search0",
      },
      {
        id: "a2",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:02.000Z",
        text: "Final citation. citeturn1search7",
      },
    ];
    const earlyUrl = "https://example.com/early";
    const finalUrl = "https://example.com/final";
    const promoted = promoteCitationSourcesToFinalAssistants(
      feed,
      new Map([
        ["a1", [{ url: earlyUrl, title: "Earlier report", referenceId: "turn0search0" }]],
        ["a2", [{ url: finalUrl, title: "Final report", referenceId: "turn1search7" }]],
      ]),
    );

    const renderMessage = (messageId: string, text: string, url: string) => {
      const sources = promoted.get(messageId) ?? [];
      return normalizeDisplayCitationMarkers(text, {
        citationMode: "html",
        citationUrlsByIndex: new Map([[1, url]]),
        citationSourcesByIndex: new Map(
          sources.map((source, index) => [index + 1, source] as const),
        ),
      });
    };
    const earlierRendered = renderMessage("a1", feed[1]?.text ?? "", earlyUrl);
    const finalRendered = renderMessage("a2", feed[2]?.text ?? "", finalUrl);

    expect(earlierRendered).toContain("Earlier report</cite>");
    expect(earlierRendered).toContain('title="__cowork_citation_sources__:');
    expect(finalRendered).toContain("Final report</cite>");
    expect(finalRendered).toContain('title="__cowork_citation_sources__:');
    expect(promoted.get("a2")?.map((source) => source.url)).toEqual([finalUrl, earlyUrl]);
  });

  test("recovers provider citation sources for earlier contiguous assistant messages", () => {
    const feed: FeedItem[] = [
      {
        id: "u1",
        kind: "message",
        role: "user",
        ts: "2024-01-01T00:00:00.000Z",
        text: "research",
      },
      {
        id: "search",
        kind: "tool",
        ts: "2024-01-01T00:00:01.000Z",
        name: "exec",
        state: "output-available",
        result: {
          citationSources: [
            {
              url: "https://example.com/first",
              title: "First source",
              referenceId: "turn0search0",
            },
            {
              url: "https://example.com/seventh",
              title: "Seventh source",
              referenceId: "turn0search7",
            },
          ],
        },
      },
      {
        id: "a1",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:02.000Z",
        text: "Earlier citation. citeturn0search7",
      },
      {
        id: "reasoning",
        kind: "reasoning",
        mode: "summary",
        ts: "2024-01-01T00:00:03.000Z",
        text: "Checking the same research results.",
      },
      {
        id: "a2",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:04.000Z",
        text: "Final citation. citeturn0search0",
      },
    ];
    const sourceMaps = buildCitationSourcesByMessageId(feed);
    const urlMaps = buildCitationUrlsByMessageId(feed);

    expect([...sourceMaps.keys()]).toEqual(["a2"]);
    const promoted = promoteCitationSourcesToFinalAssistants(feed, sourceMaps);
    const earlierSources = promoted.get("a1") ?? [];
    expect(earlierSources.map((source) => source.referenceId)).toEqual([
      "turn0search0",
      "turn0search7",
    ]);

    const earlierRendered = normalizeDisplayCitationMarkers(
      "Earlier citation. citeturn0search7",
      {
        citationMode: "html",
        citationUrlsByIndex: urlMaps.get("a1"),
        citationSourcesByIndex: new Map(
          earlierSources.map((source, index) => [index + 1, source] as const),
        ),
      },
    );

    expect(earlierRendered).toContain("Seventh source</cite>");
    expect(earlierRendered).toContain('title="__cowork_citation_sources__:');
  });
});
