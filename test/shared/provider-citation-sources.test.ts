import { describe, expect, test } from "bun:test";

import { extractReferencedCitationSourcesFromToolResult } from "../../src/shared/providerCitationSources";

const CITE = "\uE200cite";
const REF = "\uE202";

describe("extractReferencedCitationSourcesFromToolResult", () => {
  test("accepts structured citationSources with valid reference ids", () => {
    expect(
      extractReferencedCitationSourcesFromToolResult({
        citationSources: [
          {
            url: "https://example.com/a",
            referenceId: "turn0search7",
            title: " Alpha ",
          },
          {
            url: "http://example.com/b",
            referenceId: "TURN1NEWS2",
          },
        ],
      }),
    ).toEqual([
      { url: "https://example.com/a", referenceId: "turn0search7", title: "Alpha" },
      { url: "http://example.com/b", referenceId: "TURN1NEWS2" },
    ]);
  });

  test("drops structured entries with invalid urls or reference ids", () => {
    expect(
      extractReferencedCitationSourcesFromToolResult({
        citationSources: [
          { url: "javascript:alert(1)", referenceId: "turn0search1" },
          { url: "ftp://example.com/file", referenceId: "turn0search2" },
          { url: "https://example.com/ok", referenceId: "search7" },
          { url: "https://example.com/ok", referenceId: "  " },
          { url: "not-a-url", referenceId: "turn0search3" },
          "skip",
        ],
      }),
    ).toEqual([]);
  });

  test("walks nested output wrappers for structured sources", () => {
    expect(
      extractReferencedCitationSourcesFromToolResult({
        output: {
          result: {
            citationSources: [
              { url: "https://example.com/nested", referenceId: "turn2search1", title: "Nested" },
            ],
          },
        },
      }),
    ).toEqual([
      { url: "https://example.com/nested", referenceId: "turn2search1", title: "Nested" },
    ]);
  });

  test("falls back to cite-marker lines and keeps the first reference id", () => {
    const text = [
      CITE,
      "Example Title (https://example.com/doc).",
      `${REF}turn0search7 more ${REF}turn0search7`,
      "Second Title https://example.com/two",
      `${REF}turn0news1`,
    ].join("\n");

    expect(extractReferencedCitationSourcesFromToolResult(text)).toEqual([
      { url: "https://example.com/doc", title: "Example Title", referenceId: "turn0search7" },
      { url: "https://example.com/two", title: "Second Title", referenceId: "turn0news1" },
    ]);
  });

  test("prefers structured sources over cite-marker text", () => {
    expect(
      extractReferencedCitationSourcesFromToolResult({
        citationSources: [{ url: "https://example.com/structured", referenceId: "turn0search1" }],
        text: `${CITE}\nIgnored (https://example.com/text)\n${REF}turn0search9`,
      }),
    ).toEqual([{ url: "https://example.com/structured", referenceId: "turn0search1" }]);
  });

  test("ignores cite-less text and non-http fallback urls", () => {
    expect(extractReferencedCitationSourcesFromToolResult("https://example.com/no-cite")).toEqual(
      [],
    );
    expect(
      extractReferencedCitationSourcesFromToolResult(
        `${CITE}\njavascript:alert(1)\n${REF}turn0search1`,
      ),
    ).toEqual([]);
  });
});
