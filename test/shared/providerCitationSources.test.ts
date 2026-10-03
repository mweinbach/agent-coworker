import { describe, expect, test } from "bun:test";

import { extractReferencedCitationSourcesFromToolResult } from "../../src/shared/providerCitationSources";

const CITE = "\uE200cite";
const REF = "\uE202";

describe("extractReferencedCitationSourcesFromToolResult", () => {
  test("prefers structured citationSources and rejects non-http or malformed references", () => {
    expect(
      extractReferencedCitationSourcesFromToolResult({
        citationSources: [
          {
            url: "https://example.com/a",
            title: " Article ",
            referenceId: "turn0search7",
          },
          { url: "javascript:alert(1)", referenceId: "turn0search8" },
          { url: "https://example.com/b", referenceId: "search7" },
          { url: "https://example.com/c", referenceId: "  " },
          { url: "not-a-url", referenceId: "turn0news1" },
        ],
      }),
    ).toEqual([
      {
        url: "https://example.com/a",
        title: "Article",
        referenceId: "turn0search7",
      },
    ]);

    expect(
      extractReferencedCitationSourcesFromToolResult({
        output: {
          citationSources: [{ url: "http://example.com/nested", referenceId: "turn1news2" }],
        },
      }),
    ).toEqual([
      {
        url: "http://example.com/nested",
        referenceId: "turn1news2",
      },
    ]);
  });

  test("text fallback maps cite markers to the nearest preceding HTTP URL and dedupes references", () => {
    const text = [
      "Intro without a source",
      `Article Title (https://example.com/a)`,
      `${CITE}${REF}turn0search7${REF} reused ${REF}turn0search7`,
      "ftp://example.com/skip",
      `Second (https://example.com/b.)`,
      `${CITE}${REF}turn0news1`,
    ].join("\n");

    expect(extractReferencedCitationSourcesFromToolResult({ value: text })).toEqual([
      {
        url: "https://example.com/a",
        title: "Article Title",
        referenceId: "turn0search7",
      },
      {
        url: "https://example.com/b",
        title: "Second",
        referenceId: "turn0news1",
      },
    ]);
  });

  test("returns empty when cite markers or HTTP URLs are missing", () => {
    expect(extractReferencedCitationSourcesFromToolResult("https://example.com/a")).toEqual([]);
    expect(
      extractReferencedCitationSourcesFromToolResult({
        text: `${CITE}${REF}turn0search7`,
      }),
    ).toEqual([]);
    expect(extractReferencedCitationSourcesFromToolResult(null)).toEqual([]);
  });
});
