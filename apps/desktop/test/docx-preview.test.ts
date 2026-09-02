import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { decorateDocxPreviewHtml, loadDocxPreviewLayout } from "../src/lib/docxPreview";
import { setupJsdom } from "./jsdomHarness";

function setupDocxDom() {
  return setupJsdom({
    extraGlobals: { DOMParser: undefined },
    setupWindow: (dom) => {
      (globalThis as Record<string, unknown>).DOMParser = dom.window.DOMParser;
    },
  });
}

describe("decorateDocxPreviewHtml", () => {
  test("preserves explicit document styles and adds table helper classes", () => {
    const harness = setupDocxDom();

    try {
      const html = [
        '<h1 class="docx-title">Title</h1>',
        '<p class="docx-subtitle">Subtitle</p>',
        "<p><strong>Prepared March 20, 2026</strong></p>",
        "<p><em>Embargo note</em></p>",
        "<h1>Executive summary</h1>",
        "<table><tr><td><p>Cell value</p></td></tr></table>",
      ].join("");

      const decorated = decorateDocxPreviewHtml(html);

      expect(decorated).toContain('class="docx-title"');
      expect(decorated).toContain('class="docx-subtitle"');
      expect(decorated).toContain('class="docx-table"');
      expect(decorated).toContain('class="docx-cell"');
      expect(decorated).toContain('class="docx-table-paragraph"');
    } finally {
      harness.restore();
    }
  });

  test("does not invent title, byline, note, or divider roles for ordinary paragraphs", () => {
    const harness = setupDocxDom();
    try {
      const html =
        "<p>Dear reader,</p><p>First paragraph.</p><p>Second paragraph.</p><p>Regards.</p>";
      expect(decorateDocxPreviewHtml(html)).toBe(html);
    } finally {
      harness.restore();
    }
  });
});

describe("loadDocxPreviewLayout", () => {
  test("uses declared document styles instead of guessing roles from paragraph positions", async () => {
    const harness = setupDocxDom();
    try {
      const zip = new JSZip();
      const namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
      zip.file(
        "word/styles.xml",
        `<w:styles xmlns:w="${namespace}">
          <w:style w:styleId="Normal"><w:rPr><w:color w:val="123456"/><w:rFonts w:ascii="Body Font"/></w:rPr></w:style>
          <w:style w:styleId="Title"><w:rPr><w:color w:val="654321"/></w:rPr></w:style>
          <w:style w:styleId="Heading1"><w:rPr><w:color w:val="334455"/><w:rFonts w:ascii="Heading Font"/></w:rPr></w:style>
        </w:styles>`,
      );
      zip.file(
        "word/document.xml",
        `<w:document xmlns:w="${namespace}"><w:body>
          <w:p><w:r><w:rPr><w:color w:val="FF0000"/><w:rFonts w:ascii="First Paragraph Font"/></w:rPr><w:t>Ordinary text</w:t></w:r></w:p>
        </w:body></w:document>`,
      );

      const layout = await loadDocxPreviewLayout(await zip.generateAsync({ type: "arraybuffer" }));
      expect(layout).toMatchObject({
        bodyColor: "#123456",
        titleColor: "#654321",
        accentColor: "#334455",
        fontFamily: "Body Font",
      });
    } finally {
      harness.restore();
    }
  });
});
