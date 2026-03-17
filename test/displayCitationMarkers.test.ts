import { describe, expect, test } from "bun:test";

import {
  buildCitationOverflowFilePathsByMessageId,
  buildCitationUrlsByMessageId,
  extractCitationOverflowFilePathFromWebSearchResult,
  extractCitationUrlsFromWebSearchResult,
  normalizeDisplayCitationMarkers,
} from "../src/shared/displayCitationMarkers";

describe("display citation markers", () => {
  test("collapses repeated line citations for the same source", () => {
    expect(
      normalizeDisplayCitationMarkers(
        "Official details on Vera Rubin.[5†L1-L8][5†L20-L25]",
      ),
    ).toBe("Official details on Vera Rubin. [5]");
  });

  test("renders markdown links when citation URLs are available", () => {
    expect(
      normalizeDisplayCitationMarkers(
        "Sessions on AI factories[1†L12-L15] [5†L12-L15] continue all week.",
        {
          citationMode: "markdown",
          citationUrlsByIndex: new Map([
            [1, "https://example.com/1"],
            [5, "https://example.com/5"],
          ]),
        },
      ),
    ).toBe("Sessions on AI factories [1](https://example.com/1), [5](https://example.com/5) continue all week.");
  });

  test("renders superscript HTML links for desktop display", () => {
    expect(
      normalizeDisplayCitationMarkers(
        "Robotics updates[1†L1-L8].",
        {
          citationMode: "html",
          citationUrlsByIndex: new Map([[1, "https://example.com/1"]]),
        },
      ),
    ).toBe('Robotics updates<sup><a href="https://example.com/1">1</a></sup>.');
  });

  test("drops unresolved citations without leaving spacing artifacts", () => {
    expect(
      normalizeDisplayCitationMarkers(
        "Later source details[5†L1-L8].",
        {
          citationMode: "html",
          citationUrlsByIndex: new Map([[1, "https://example.com/1"]]),
        },
      ),
    ).toBe("Later source details.");
  });

  test("extracts ordered URLs from webSearch text results", () => {
    expect(
      extractCitationUrlsFromWebSearchResult([
        "Source One",
        "https://example.com/one",
        "Summary",
        "",
        "Source Two",
        "https://example.com/two",
      ].join("\n")),
    ).toEqual(new Map([
      [1, "https://example.com/one"],
      [2, "https://example.com/two"],
    ]));
  });

  test("tracks latest webSearch citation context by assistant message id", () => {
    const feed = [
      { id: "user-1", kind: "message", role: "user" as const },
      {
        id: "tool-1",
        kind: "tool" as const,
        name: "webSearch",
        result: {
          type: "text",
          value: ["One", "https://example.com/one", "", "Two", "https://example.com/two"].join("\n"),
        },
      },
      { id: "assistant-1", kind: "message", role: "assistant" as const },
    ];

    expect(buildCitationUrlsByMessageId(feed)).toEqual(new Map([
      ["assistant-1", new Map([
        [1, "https://example.com/one"],
        [2, "https://example.com/two"],
      ])],
    ]));
  });

  test("prefers native assistant annotations when present", () => {
    const feed = [
      { id: "user-1", kind: "message", role: "user" as const },
      {
        id: "tool-1",
        kind: "tool" as const,
        name: "nativeWebSearch",
        result: {
          sources: [{ url: "https://stale.example.com" }],
        },
      },
      {
        id: "assistant-1",
        kind: "message" as const,
        role: "assistant" as const,
        annotations: [
          {
            type: "url_citation",
            start_index: 0,
            end_index: 6,
            url: "https://example.com/fresh",
          },
        ],
      },
    ];

    expect(buildCitationUrlsByMessageId(feed)).toEqual(new Map([
      ["assistant-1", new Map([[1, "https://example.com/fresh"]])],
    ]));
  });

  test("falls back to native web search sources when annotations are unavailable", () => {
    const feed = [
      { id: "user-1", kind: "message", role: "user" as const },
      {
        id: "tool-1",
        kind: "tool" as const,
        name: "nativeWebSearch",
        result: {
          action: {
            type: "search",
            query: "openai responses",
            sources: [
              { url: "https://example.com/one" },
              { url: "https://example.com/two" },
            ],
          },
        },
      },
      { id: "assistant-1", kind: "message", role: "assistant" as const },
    ];

    expect(buildCitationUrlsByMessageId(feed)).toEqual(new Map([
      ["assistant-1", new Map([
        [1, "https://example.com/one"],
        [2, "https://example.com/two"],
      ])],
    ]));
  });

  test("surfaces overflow file paths for later citation hydration", () => {
    const result = {
      type: "text",
      value: "Tool output overflowed.",
      overflow: true,
      filePath: "/tmp/search-results.txt",
    };
    expect(extractCitationOverflowFilePathFromWebSearchResult(result)).toBe("/tmp/search-results.txt");
    expect(buildCitationOverflowFilePathsByMessageId([
      { id: "user-1", kind: "message", role: "user" as const },
      { id: "tool-1", kind: "tool" as const, name: "webSearch", result },
      { id: "assistant-1", kind: "message", role: "assistant" as const },
    ])).toEqual(new Map([["assistant-1", "/tmp/search-results.txt"]]));
  });

  test("inserts inline citation markers from native annotations", () => {
    expect(
      normalizeDisplayCitationMarkers("Search result", {
        citationMode: "markdown",
        annotations: [
          {
            type: "url_citation",
            start_index: 0,
            end_index: 6,
            url: "https://example.com/search",
          },
        ],
      }),
    ).toBe("Search [1](https://example.com/search) result");
  });

  test("appends a compact sources footer when native citations only exist out of band", () => {
    expect(
      normalizeDisplayCitationMarkers("Answer", {
        citationMode: "markdown",
        fallbackToSourcesFooter: true,
        citationUrlsByIndex: new Map([
          [1, "https://example.com/one"],
          [2, "https://example.com/two"],
        ]),
      }),
    ).toBe("Answer\n\nSources: [1](https://example.com/one), [2](https://example.com/two)");
  });
});
