import { describe, expect, test } from "bun:test";

import {
  normalizeInlineLinkHref,
  parseInlineMarkdown,
} from "../apps/mobile/src/features/cowork/inlineMarkdown";

describe("mobile inline markdown links", () => {
  test("parses markdown links", () => {
    const runs = parseInlineMarkdown(
      "See [Apple docs](https://www.apple.com/apple-intelligence/).",
    );
    expect(runs).toEqual([
      { type: "text", content: "See " },
      {
        type: "link",
        label: "Apple docs",
        href: "https://www.apple.com/apple-intelligence/",
      },
      { type: "text", content: "." },
    ]);
  });

  test("parses bare https urls", () => {
    const runs = parseInlineMarkdown(
      "Sources:\n1. https://support.apple.com/en-us/121115\n2. https://www.apple.com/apple-intelligence/",
    );
    expect(runs).toEqual([
      { type: "text", content: "Sources:\n1. " },
      {
        type: "link",
        label: "https://support.apple.com/en-us/121115",
        href: "https://support.apple.com/en-us/121115",
      },
      { type: "text", content: "\n2. " },
      {
        type: "link",
        label: "https://www.apple.com/apple-intelligence/",
        href: "https://www.apple.com/apple-intelligence/",
      },
    ]);
  });

  test("normalizes www links", () => {
    expect(normalizeInlineLinkHref("www.apple.com")).toBe("https://www.apple.com");
  });

  test("does not parse links inside inline code", () => {
    const runs = parseInlineMarkdown("Use `https://example.com` literally.");
    expect(runs).toEqual([
      { type: "text", content: "Use " },
      { type: "code", content: "https://example.com" },
      { type: "text", content: " literally." },
    ]);
  });

  test("preserves bold and italic alongside links", () => {
    const runs = parseInlineMarkdown("**Sources:** https://example.com and *more*");
    expect(runs).toEqual([
      { type: "bold", content: "Sources:" },
      { type: "text", content: " " },
      { type: "link", label: "https://example.com", href: "https://example.com" },
      { type: "text", content: " and " },
      { type: "italic", content: "more" },
    ]);
  });
});
