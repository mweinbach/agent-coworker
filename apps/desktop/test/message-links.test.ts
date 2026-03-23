import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  decodeDesktopLocalFileHref,
  encodeDesktopLocalFileHref,
  fileUrlToDesktopPath,
  MessageResponse,
  remarkRewriteDesktopFileLinks,
  rewriteBareDesktopFilePathsInTree,
  rewriteDesktopFileLinksInTree,
} from "../src/components/ai-elements/message";

describe("desktop message local file links", () => {
  test("converts file URLs into desktop paths", () => {
    expect(fileUrlToDesktopPath("file:///Users/mweinbach/Desktop/Cowork%20Test/create_models.py")).toBe(
      "/Users/mweinbach/Desktop/Cowork Test/create_models.py",
    );
    expect(fileUrlToDesktopPath("file:///C:/Users/Test/Desktop/Cowork%20Test/create_models.py")).toBe(
      "C:\\Users\\Test\\Desktop\\Cowork Test\\create_models.py",
    );
    expect(fileUrlToDesktopPath("https://example.com")).toBeNull();
  });

  test("round-trips encoded desktop local file hrefs", () => {
    const encodedHref = encodeDesktopLocalFileHref("file:///Users/mweinbach/Desktop/Cowork%20Test/create_models.py");
    expect(encodedHref).toBe("cowork-file://open?path=%2FUsers%2Fmweinbach%2FDesktop%2FCowork%20Test%2Fcreate_models.py");
    expect(decodeDesktopLocalFileHref(encodedHref)).toBe("/Users/mweinbach/Desktop/Cowork Test/create_models.py");
    expect(decodeDesktopLocalFileHref("https://example.com")).toBeNull();
  });

  test("rewrites file links in markdown trees without touching normal links", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "file:///Users/mweinbach/Desktop/Cowork%20Test/create_models.py",
              children: [{ type: "text", value: "create_models.py" }],
            },
            {
              type: "link",
              url: "https://example.com/docs",
              children: [{ type: "text", value: "docs" }],
            },
          ],
        },
      ],
    };

    rewriteDesktopFileLinksInTree(tree);

    expect(tree.children[0]?.children[0]?.url).toBe(
      "cowork-file://open?path=%2FUsers%2Fmweinbach%2FDesktop%2FCowork%20Test%2Fcreate_models.py",
    );
    expect(tree.children[0]?.children[1]?.url).toBe("https://example.com/docs");
  });

  test("rewrites bare desktop file paths into local links with basename labels", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "PDF: C:\\Users\\Test\\Desktop\\Cowork Test\\macbook_neo_report.pdf" }],
        },
      ],
    };

    rewriteBareDesktopFilePathsInTree(tree);

    expect(tree.children[0]?.children).toEqual([
      { type: "text", value: "PDF: " },
      {
        type: "link",
        url: "file:///C:/Users/Test/Desktop/Cowork%20Test/macbook_neo_report.pdf",
        children: [{ type: "text", value: "macbook_neo_report.pdf" }],
      },
    ]);
  });

  test("remark transformer also rewrites rendered anchor hrefs", () => {
    const transform = remarkRewriteDesktopFileLinks();
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "a",
          properties: {
            href: "file:///Users/mweinbach/Desktop/Cowork%20Test/output/AAPL_DCF_Model.xlsx",
          },
          children: [{ type: "text", value: "AAPL_DCF_Model.xlsx" }],
        },
      ],
    };

    transform(tree);

    expect(tree.children[0]?.properties?.href).toBe(
      "cowork-file://open?path=%2FUsers%2Fmweinbach%2FDesktop%2FCowork%20Test%2Foutput%2FAAPL_DCF_Model.xlsx",
    );
  });

  test("normalizes full-path local markdown labels down to basenames", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        null,
        "[C:\\Users\\Test\\Desktop\\Cowork Test\\create_models.py](file:///C:/Users/Test/Desktop/Cowork%20Test/create_models.py)",
      ),
    );

    expect(html).toContain("create_models.py");
    expect(html).toContain("<button");
    expect(html).not.toContain("C:\\Users\\Test\\Desktop\\Cowork Test\\create_models.py");
  });

  test("renders local file citations without blocked markers", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        null,
        "- [create_models.py](file:///Users/mweinbach/Desktop/Cowork%20Test/create_models.py)",
      ),
    );

    expect(html).toContain("create_models.py");
    expect(html).toContain("<button");
    expect(html).not.toContain("[blocked]");
  });

  test("auto-links bare absolute file paths in rendered assistant text", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        null,
        [
          "Updated files:",
          "- PDF: C:\\Users\\Test\\Desktop\\Cowork Test\\macbook_neo_report.pdf",
          "- Page 1: C:\\Users\\Test\\Desktop\\Cowork Test\\macbook_neo_report_page_1.png",
        ].join("\n"),
      ),
    );

    expect((html.match(/<button/g) ?? []).length).toBe(2);
    expect(html).toContain("macbook_neo_report.pdf");
    expect(html).toContain("macbook_neo_report_page_1.png");
    expect(html).not.toContain("C:\\Users\\Test\\Desktop\\Cowork Test\\macbook_neo_report.pdf");
    expect(html).not.toContain("C:\\Users\\Test\\Desktop\\Cowork Test\\macbook_neo_report_page_1.png");
  });

  test("auto-links file paths inside inline code when the entire value is a path", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        null,
        "`C:\\Users\\Test\\Desktop\\Cowork Test\\create_models.py`",
      ),
    );

    expect(html).toContain("<button");
    expect(html).toContain("create_models.py");
    expect(html).not.toContain("C:\\Users\\Test\\Desktop\\Cowork Test\\create_models.py");
  });

  test("renders assistant citations as superscript links when URLs are available", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        {
          normalizeDisplayCitations: true,
          citationUrlsByIndex: new Map([[5, "https://example.com/source-5"]]),
        },
        "Official details on Vera Rubin.[5†L1-L8][5†L20-L25]",
      ),
    );

    expect(html).toContain('data-streamdown="superscript"');
    expect(html).toContain('href="https://example.com/source-5"');
    expect(html).toContain(">5<");
    expect(html).not.toContain("†L");
  });

  test("renders markdown-backed native annotations after the visible sentence", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        {
          normalizeDisplayCitations: true,
          citationAnnotations: [
            {
              type: "url_citation",
              start_index: 0,
              end_index: "The Collision: Plane hit a truck.".length,
              url: "https://example.com/collision",
            },
          ],
          citationUrlsByIndex: new Map([[1, "https://example.com/collision"]]),
        },
        "* **The Collision:** Plane hit a truck.",
      ),
    );

    expect(html).toContain("The Collision:");
    expect(html).toContain("Plane hit a truck.<sup");
    expect(html).toContain('href="https://example.com/collision"');
    expect(html).not.toContain("tru<sup");
  });

  test("renders raw-source Google-style annotations at sentence boundaries instead of the next bullet", () => {
    const text = [
      "* **The Collision:** Plane hit a truck.",
      "* **Casualties:** The pilot was killed. Over 40 others were injured. Most have been released.",
    ].join("\n");

    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        {
          normalizeDisplayCitations: true,
          citationAnnotations: [
            {
              type: "url_citation",
              start_index: 0,
              end_index: text.indexOf("truck.") + "truck.".length - 1,
              url: "https://example.com/collision",
            },
            {
              type: "url_citation",
              start_index: 0,
              end_index: text.indexOf("Most") + 2,
              url: "https://example.com/injuries",
            },
          ],
          citationUrlsByIndex: new Map([
            [1, "https://example.com/collision"],
            [2, "https://example.com/injuries"],
          ]),
        },
        text,
      ),
    );

    expect(html).toContain("truck.<sup");
    expect(html).toContain("injured.<sup");
    expect(html).not.toContain("Casu<sup");
    expect(html).not.toContain("Mos<sup");
  });
});
