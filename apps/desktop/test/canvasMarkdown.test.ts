import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanMarkdown, markdownToHtml, nodeToMarkdown } from "../src/lib/canvasMarkdown";
import { type JsdomHarness, setupJsdom } from "./jsdomHarness";

describe("markdownToHtml", () => {
  test("renders ordered lists with an <ol> wrapper", () => {
    const html = markdownToHtml("1. first\n2. second\n3. third");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
    expect(html).toContain("<li>third</li>");
    expect(html).toContain("</ol>");
    expect(html).not.toContain("<ul>");
  });

  test("renders unordered lists for - and * markers followed by a space", () => {
    expect(markdownToHtml("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(markdownToHtml("* a\n* b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  test("does NOT treat an emphasis-only line as a list item", () => {
    const html = markdownToHtml("*just emphasis*");
    expect(html).toContain("<em>just emphasis</em>");
    expect(html).not.toContain("<li>");
    expect(html).not.toContain("<ul>");
  });

  test("does NOT treat dash-prefixed prose (no trailing space) as a list", () => {
    const html = markdownToHtml("-5 degrees below zero");
    expect(html).toContain("<p>");
    expect(html).toContain("-5 degrees below zero");
    expect(html).not.toContain("<li>");
  });

  test("parses inline bold, italic, code, and links", () => {
    const html = markdownToHtml("**bold** and *italic* and `code` and [link](https://example.com)");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://example.com"');
  });

  test("renders headings, blockquotes, code blocks, and horizontal rules", () => {
    expect(markdownToHtml("# Title")).toContain("<h1>Title</h1>");
    expect(markdownToHtml("### Sub")).toContain("<h3>Sub</h3>");
    expect(markdownToHtml("> quoted")).toContain("<blockquote>quoted</blockquote>");
    expect(markdownToHtml("```\ncode line\n```")).toContain("<pre><code>code line</code></pre>");
    expect(markdownToHtml("---")).toContain("<hr>");
  });

  test("escapes raw HTML in document content", () => {
    const html = markdownToHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("neutralizes javascript: links but keeps safe protocols and relative paths", () => {
    const jsLink = markdownToHtml("[click](javascript:alert(1))");
    expect(jsLink).not.toContain("javascript:");
    expect(jsLink).toContain('href="#"');

    expect(markdownToHtml("[ext](https://example.com)")).toContain('href="https://example.com"');
    expect(markdownToHtml("[rel](./other.md)")).toContain('href="./other.md"');
    expect(markdownToHtml("[mail](mailto:a@b.com)")).toContain('href="mailto:a@b.com"');
  });

  test("keeps Windows absolute paths in markdown links", () => {
    expect(markdownToHtml("[drive](C:\\Users\\me\\notes.md)")).toContain(
      'href="C:\\Users\\me\\notes.md"',
    );
    expect(markdownToHtml("[drive](C:/Users/me/notes.md)")).toContain(
      'href="C:/Users/me/notes.md"',
    );
    expect(markdownToHtml("[unc](\\\\server\\share\\notes.md)")).toContain(
      'href="\\\\server\\share\\notes.md"',
    );
  });

  test("returns an empty paragraph for empty input", () => {
    expect(markdownToHtml("")).toBe("<p><br></p>");
  });
});

describe("nodeToMarkdown round-trip", () => {
  let harness: JsdomHarness;

  beforeEach(() => {
    harness = setupJsdom();
  });

  afterEach(() => {
    harness.restore();
  });

  function roundTrip(md: string): string {
    const container = document.createElement("div");
    container.innerHTML = markdownToHtml(md);
    return cleanMarkdown(nodeToMarkdown(container));
  }

  test("preserves ordered-list numbering (regression: numbers became bullets)", () => {
    expect(roundTrip("1. first\n2. second\n3. third")).toBe("1. first\n2. second\n3. third");
  });

  test("serializes an <ol> built directly in the DOM back to numbers", () => {
    const container = document.createElement("div");
    container.innerHTML = "<ol><li>alpha</li><li>beta</li></ol>";
    expect(cleanMarkdown(nodeToMarkdown(container))).toBe("1. alpha\n2. beta");
  });

  test("preserves unordered lists as dash bullets", () => {
    expect(roundTrip("- a\n- b")).toBe("- a\n- b");
  });

  test("preserves headings, bold, and italic on round-trip", () => {
    expect(roundTrip("# Title")).toBe("# Title");
    expect(roundTrip("**bold**")).toBe("**bold**");
    expect(roundTrip("*italic*")).toBe("*italic*");
  });

  test("round-trips a mixed document with a heading, ordered list, and paragraph", () => {
    const md = "# Doc\n\n1. one\n2. two\n\nPara text";
    expect(roundTrip(md)).toBe("# Doc\n\n1. one\n2. two\n\nPara text");
  });
});
