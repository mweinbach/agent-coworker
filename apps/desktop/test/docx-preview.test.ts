import { describe, expect, test } from "bun:test";

import { decorateDocxPreviewHtml } from "../src/lib/docxPreview";
import { setupJsdom } from "./jsdomHarness";

describe("decorateDocxPreviewHtml", () => {
  test("adds intro block classes, divider, and table helper classes", () => {
    const harness = setupJsdom({
      extraGlobals: {
        DOMParser: undefined,
      },
      setupWindow: (dom) => {
        (globalThis as Record<string, unknown>).DOMParser = dom.window.DOMParser;
      },
    });

    try {
      const html = [
        "<p><strong>Title</strong></p>",
        "<p>Subtitle</p>",
        "<p><strong>Prepared March 20, 2026</strong></p>",
        "<p><em>Embargo note</em></p>",
        "<h1>Executive summary</h1>",
        "<table><tr><td><p>Cell value</p></td></tr></table>",
      ].join("");

      const decorated = decorateDocxPreviewHtml(html);

      expect(decorated).toContain('class="docx-title"');
      expect(decorated).toContain('class="docx-subtitle"');
      expect(decorated).toContain('class="docx-byline"');
      expect(decorated).toContain('class="docx-note"');
      expect(decorated).toContain('class="docx-divider"');
      expect(decorated).toContain('class="docx-table"');
      expect(decorated).toContain('class="docx-cell"');
      expect(decorated).toContain('class="docx-table-paragraph"');
    } finally {
      harness.restore();
    }
  });
});
