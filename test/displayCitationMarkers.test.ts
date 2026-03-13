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
});
