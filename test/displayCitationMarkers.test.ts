import { describe, expect, test } from "bun:test";

import {
  buildCitationOverflowFilePathsByMessageId,
  buildCitationSourcesByMessageId,
  buildCitationUrlsByMessageId,
  describeCitationSource,
  extractCitationSourcesFromWebSearchResult,
  extractCitationOverflowFilePathFromWebSearchResult,
  extractCitationUrlsFromWebSearchResult,
  isOpaqueCitationRedirectUrl,
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

  test("extracts ordered URLs and titles from structured webSearch results", () => {
    const result = {
      provider: "exa",
      count: 2,
      response: {
        results: [
          { title: "Source One", url: "https://example.com/one", highlights: ["One"] },
          { title: "Source Two", url: "https://example.com/two", highlights: ["Two"] },
        ],
      },
    };

    expect(extractCitationUrlsFromWebSearchResult(result)).toEqual(new Map([
      [1, "https://example.com/one"],
      [2, "https://example.com/two"],
    ]));
    expect(extractCitationSourcesFromWebSearchResult(result)).toEqual([
      { title: "Source One", url: "https://example.com/one" },
      { title: "Source Two", url: "https://example.com/two" },
    ]);
  });

  test("treats Google grounding redirects as opaque display URLs", () => {
    const source = {
      title: "cbsnews.com",
      url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH4iedWtHk5dpRaMko9c5l9JzmcarVDEORW9szHs95gjSSCj2JkhUUyZvaidzIWRapHw_3-kZ7dCNLNntqbNOG-1k1kPLkRV77xUiqNQZ2hgjRNwSIsvIO0LzWHRiZctDIIpgP8RF0M5PxFPx_NDRrWdX84KIiwhoTOJp2zgYRiG_IQu2QGnPiGcX2MdP6NcIWkgJfjNk0XM9FfYY_dHpZJqg==",
    };

    expect(isOpaqueCitationRedirectUrl(source.url)).toBe(true);
    expect(describeCitationSource(source)).toEqual({
      titleLabel: "cbsnews.com",
      hostLabel: "cbsnews.com",
      displayUrl: null,
      faviconHostname: "cbsnews.com",
      opaqueRedirect: true,
    });
  });

  test("extracts citation sources from overflowed JSON spill content", () => {
    const spillContent = JSON.stringify({
      provider: "exa",
      count: 2,
      response: {
        results: [
          { title: "Source One", url: "https://example.com/one" },
          { title: "Source Two", url: "https://example.com/two" },
        ],
      },
    }, null, 2);

    expect(extractCitationUrlsFromWebSearchResult(spillContent)).toEqual(new Map([
      [1, "https://example.com/one"],
      [2, "https://example.com/two"],
    ]));
    expect(extractCitationSourcesFromWebSearchResult(spillContent)).toEqual([
      { title: "Source One", url: "https://example.com/one" },
      { title: "Source Two", url: "https://example.com/two" },
    ]);
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

  test("tracks latest structured webSearch sources by assistant message id", () => {
    const feed = [
      { id: "user-1", kind: "message", role: "user" as const },
      {
        id: "tool-1",
        kind: "tool" as const,
        name: "webSearch",
        result: {
          provider: "exa",
          count: 2,
          response: {
            results: [
              { title: "Source One", url: "https://example.com/one" },
              { title: "Source Two", url: "https://example.com/two" },
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
    expect(buildCitationSourcesByMessageId(feed)).toEqual(new Map([
      ["assistant-1", [
        { title: "Source One", url: "https://example.com/one" },
        { title: "Source Two", url: "https://example.com/two" },
      ]],
    ]));
  });

  test("clears stale webSearch citations when a later search returns no results", () => {
    const feed = [
      { id: "user-1", kind: "message", role: "user" as const },
      {
        id: "tool-1",
        kind: "tool" as const,
        name: "webSearch",
        result: {
          provider: "exa",
          count: 2,
          response: {
            results: [
              { title: "Source One", url: "https://example.com/one" },
              { title: "Source Two", url: "https://example.com/two" },
            ],
          },
        },
      },
      { id: "assistant-1", kind: "message", role: "assistant" as const },
      {
        id: "tool-2",
        kind: "tool" as const,
        name: "webSearch",
        result: {
          provider: "exa",
          count: 0,
          response: {
            results: [],
          },
        },
      },
      { id: "assistant-2", kind: "message", role: "assistant" as const },
    ];

    expect(buildCitationUrlsByMessageId(feed)).toEqual(new Map([
      ["assistant-1", new Map([
        [1, "https://example.com/one"],
        [2, "https://example.com/two"],
      ])],
    ]));
    expect(buildCitationSourcesByMessageId(feed)).toEqual(new Map([
      ["assistant-1", [
        { title: "Source One", url: "https://example.com/one" },
        { title: "Source Two", url: "https://example.com/two" },
      ]],
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

  test("maps place citations from Gemini annotations into inline markers", () => {
    expect(
      normalizeDisplayCitationMarkers("Coffee nearby", {
        citationMode: "markdown",
        annotations: [
          {
            type: "place_citation",
            start_index: 0,
            end_index: 6,
            name: "Blue Bottle Coffee",
            url: "https://maps.google.com/?cid=123",
          },
        ],
      }),
    ).toBe("Coffee [1](https://maps.google.com/?cid=123) nearby");
  });

  test("maps native annotation offsets against rendered markdown text", () => {
    const out = normalizeDisplayCitationMarkers("* **The Collision:** Plane hit a truck.", {
      citationMode: "html",
      annotations: [
        {
          type: "url_citation",
          start_index: 0,
          end_index: "The Collision: Plane hit a truck.".length,
          title: "Collision Report",
          url: "https://example.com/collision",
        },
      ],
    });

    expect(out).toContain('* **The Collision:** Plane hit a truck.<cite');
    expect(out).toContain('__cowork_citation_sources__:');
    expect(out).toContain('>Collision Report</cite>');
  });

  test("clusters native annotations into one paragraph-end chip per markdown block", () => {
    const text = [
      "* **The Collision:** Plane hit a truck.",
      "* **Casualties:** The pilot was killed. Over 40 others were injured. Most have been released.",
    ].join("\n");

    const afterTruckPeriod = text.indexOf("truck.") + "truck.".length - 1;
    const afterKilledPeriod = text.indexOf("killed.") + "killed.".length - 1;
    const insideMost = text.indexOf("Most") + 2;

    const out = normalizeDisplayCitationMarkers(text, {
      citationMode: "html",
      annotations: [
        { type: "url_citation", start_index: 0, end_index: afterTruckPeriod, title: "Collision Report", url: "https://example.com/collision" },
        { type: "url_citation", start_index: 0, end_index: afterKilledPeriod, title: "Safety Memo", url: "https://example.com/killed" },
        { type: "url_citation", start_index: 0, end_index: insideMost, title: "Hospital Update", url: "https://example.com/injuries" },
      ],
    });

    expect(out).toContain('* **The Collision:** Plane hit a truck.<cite');
    expect(out).toContain('>Collision Report</cite>');
    expect(out).toContain('* **Casualties:** The pilot was killed. Over 40 others were injured. Most have been released.<cite');
    expect(out).toContain('>Safety Memo +1</cite>');
    expect(out).not.toContain("injured.<cite");
  });

  test("tracks native URL context sources for assistant messages", () => {
    const feed = [
      { id: "user-1", kind: "message", role: "user" as const },
      {
        id: "tool-1",
        kind: "tool" as const,
        name: "nativeUrlContext",
        result: {
          provider: "google",
          urls: ["https://example.com/about"],
          results: [{ url: "https://example.com/about", status: "success" }],
        },
      },
      { id: "assistant-1", kind: "message", role: "assistant" as const },
    ];

    expect(buildCitationUrlsByMessageId(feed)).toEqual(new Map([
      ["assistant-1", new Map([[1, "https://example.com/about"]])],
    ]));
  });

  test("clears stale native URL context citations and sources when a later result is empty", () => {
    const feed = [
      { id: "user-1", kind: "message", role: "user" as const },
      {
        id: "tool-1",
        kind: "tool" as const,
        name: "nativeUrlContext",
        result: {
          provider: "google",
          urls: ["https://example.com/about"],
          results: [{ url: "https://example.com/about", status: "success" }],
        },
      },
      { id: "assistant-1", kind: "message", role: "assistant" as const },
      {
        id: "tool-2",
        kind: "tool" as const,
        name: "nativeUrlContext",
        result: {
          provider: "google",
          results: [],
        },
      },
      { id: "assistant-2", kind: "message", role: "assistant" as const },
    ];

    expect(buildCitationUrlsByMessageId(feed)).toEqual(new Map([
      ["assistant-1", new Map([[1, "https://example.com/about"]])],
    ]));
    expect(buildCitationSourcesByMessageId(feed)).toEqual(new Map([
      ["assistant-1", [
        { url: "https://example.com/about" },
      ]],
    ]));
  });

  test("clears stale native web search citations and sources when a later result is empty", () => {
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
              { title: "Source One", url: "https://example.com/one" },
              { title: "Source Two", url: "https://example.com/two" },
            ],
          },
        },
      },
      { id: "assistant-1", kind: "message", role: "assistant" as const },
      {
        id: "tool-2",
        kind: "tool" as const,
        name: "nativeWebSearch",
        result: {
          action: {
            type: "search",
            query: "openai responses empty",
            sources: [],
          },
        },
      },
      { id: "assistant-2", kind: "message", role: "assistant" as const },
    ];

    expect(buildCitationUrlsByMessageId(feed)).toEqual(new Map([
      ["assistant-1", new Map([
        [1, "https://example.com/one"],
        [2, "https://example.com/two"],
      ])],
    ]));
    expect(buildCitationSourcesByMessageId(feed)).toEqual(new Map([
      ["assistant-1", [
        { title: "Source One", url: "https://example.com/one" },
        { title: "Source Two", url: "https://example.com/two" },
      ]],
    ]));
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
