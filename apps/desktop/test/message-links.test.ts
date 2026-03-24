import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";

import {
  decodeDesktopExternalHref,
  encodeDesktopExternalHref,
  decodeDesktopLocalFileHref,
  encodeDesktopLocalFileHref,
  fileUrlToDesktopPath,
  MessageResponse,
  remarkRewriteDesktopFileLinks,
  rewriteBareDesktopFilePathsInTree,
  rewriteDesktopFileLinksInTree,
} from "../src/components/ai-elements/message";
import { setupJsdom } from "./jsdomHarness";

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

  test("round-trips encoded desktop external app hrefs", () => {
    const encodedHref = encodeDesktopExternalHref("craftdocs://open?spaceId=abc&documentId=def");
    expect(encodedHref).toBe(
      "cowork-external://open?url=craftdocs%3A%2F%2Fopen%3FspaceId%3Dabc%26documentId%3Ddef",
    );
    expect(decodeDesktopExternalHref(encodedHref)).toBe("craftdocs://open?spaceId=abc&documentId=def");
    expect(decodeDesktopExternalHref("https://example.com")).toBeNull();
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

  test("rewrites custom app links into desktop-safe hrefs before sanitize", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "craftdocs://open?spaceId=abc&documentId=def",
              children: [{ type: "text", value: "Craft" }],
            },
          ],
        },
      ],
    };

    rewriteDesktopFileLinksInTree(tree);

    expect(tree.children[0]?.children[0]?.url).toBe(
      "cowork-external://open?url=craftdocs%3A%2F%2Fopen%3FspaceId%3Dabc%26documentId%3Ddef",
    );
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

  test("renders custom app markdown links without blocked markers", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        null,
        "[Intel Pro Day 2026](craftdocs://open?spaceId=abc&documentId=def)",
      ),
    );

    expect(html).toContain("Intel Pro Day 2026");
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
          citationSources: [{ title: "Collision Report", url: "https://example.com/collision" }],
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
    expect(html).toContain("Plane hit a truck.<cite");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain(">Collision Report<");
    expect(html).not.toContain("tru<cite");
  });

  test("renders raw-source Google-style annotations as one chip at the end of each bullet", () => {
    const text = [
      "* **The Collision:** Plane hit a truck.",
      "* **Casualties:** The pilot was killed. Over 40 others were injured. Most have been released.",
    ].join("\n");

    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        {
          normalizeDisplayCitations: true,
          citationSources: [
            { title: "Collision Report", url: "https://example.com/collision" },
            { title: "Safety Memo", url: "https://example.com/killed" },
            { title: "Hospital Update", url: "https://example.com/injuries" },
          ],
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
              end_index: text.indexOf("killed.") + "killed.".length - 1,
              url: "https://example.com/killed",
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
            [2, "https://example.com/killed"],
            [3, "https://example.com/injuries"],
          ]),
        },
        text,
      ),
    );

    expect(html).toContain("truck.<cite");
    expect(html).toContain("released.<cite");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain(">Collision Report<");
    expect(html).toContain(">Safety Memo +1<");
    expect(html).not.toContain("injured.<cite");
    expect(html).not.toContain("Casu<cite");
    expect(html).not.toContain("Mos<cite");
  });

  test("citation chips open a source popup and navigate grouped sources with arrows", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      const text = [
        "* **The Collision:** Plane hit a truck.",
        "* **Casualties:** The pilot was killed. Over 40 others were injured. Most have been released.",
      ].join("\n");

      await act(async () => {
        root.render(
          createElement(
            MessageResponse,
            {
              normalizeDisplayCitations: true,
              citationSources: [
                { title: "Collision Report", url: "https://example.com/collision" },
                { title: "Safety Memo", url: "https://example.com/killed" },
                { title: "Hospital Update", url: "https://example.com/injuries" },
              ],
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
                  end_index: text.indexOf("killed.") + "killed.".length - 1,
                  url: "https://example.com/killed",
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
                [2, "https://example.com/killed"],
                [3, "https://example.com/injuries"],
              ]),
            },
            text,
          ),
        );
      });

      const chipButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Safety Memo +1"));
      if (!chipButton) {
        throw new Error("missing grouped citation chip button");
      }

      await act(async () => {
        chipButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(harness.dom.window.document.body.textContent).toContain("1/2");
      expect(harness.dom.window.document.body.textContent).toContain("Safety Memo");
      expect(harness.dom.window.document.body.textContent).toContain("https://example.com/killed");

      const popup = harness.dom.window.document.querySelector('[role="dialog"][aria-label="Citation sources"]');
      expect(popup?.getAttribute("class")).toContain("fixed");
      expect(popup?.getAttribute("class")).toContain("z-[70]");
      expect(popup?.getAttribute("class")).toContain("w-[min(18rem,calc(100vw-2rem))]");

      const nextButton = harness.dom.window.document.querySelector('button[aria-label="Next source"]');
      if (!nextButton) {
        throw new Error("missing next source button");
      }

      await act(async () => {
        nextButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(harness.dom.window.document.body.textContent).toContain("2/2");
      expect(harness.dom.window.document.body.textContent).toContain("Hospital Update");
      expect(harness.dom.window.document.body.textContent).toContain("https://example.com/injuries");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("citation chips prewarm favicon URLs before the popup opens", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      const assignedImageUrls: string[] = [];
      const OriginalWindowImage = harness.dom.window.Image;
      const OriginalGlobalImage = globalThis.Image;

      class TrackingImage {
        set src(value: string) {
          assignedImageUrls.push(value);
        }
      }

      harness.dom.window.Image = TrackingImage as unknown as typeof harness.dom.window.Image;
      globalThis.Image = TrackingImage as unknown as typeof globalThis.Image;

      try {
        await act(async () => {
          root.render(
            createElement(
              MessageResponse,
              {
                normalizeDisplayCitations: true,
                citationSources: [{ title: "preload-check.example", url: "https://example.com/preload-check" }],
                citationAnnotations: [
                  {
                    type: "url_citation",
                    start_index: 0,
                    end_index: 11,
                    url: "https://example.com/preload-check",
                    title: "preload-check.example",
                  },
                ],
                citationUrlsByIndex: new Map([[1, "https://example.com/preload-check"]]),
              },
              "Source block.",
            ),
          );
        });

        expect(assignedImageUrls).toContain("https://www.google.com/s2/favicons?domain=preload-check.example&sz=32");

        await act(async () => {
          root.unmount();
        });
      } finally {
        harness.dom.window.Image = OriginalWindowImage;
        globalThis.Image = OriginalGlobalImage;
      }
    } finally {
      harness.restore();
    }
  });

  test("Google redirect citation popups hide opaque URLs and keep site labels", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      const text = "* **Airport Impact:** LaGuardia closed while investigators responded.";
      const redirectUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH4iedWtHk5dpRaMko9c5l9JzmcarVDEORW9szHs95gjSSCj2JkhUUyZvaidzIWRapHw_3-kZ7dCNLNntqbNOG-1k1kPLkRV77xUiqNQZ2hgjRNwSIsvIO0LzWHRiZctDIIpgP8RF0M5PxFPx_NDRrWdX84KIiwhoTOJp2zgYRiG_IQu2QGnPiGcX2MdP6NcIWkgJfjNk0XM9FfYY_dHpZJqg==";

      await act(async () => {
        root.render(
          createElement(
            MessageResponse,
            {
              normalizeDisplayCitations: true,
              citationSources: [{ title: "cbsnews.com", url: redirectUrl }],
              citationAnnotations: [
                {
                  type: "url_citation",
                  start_index: 0,
                  end_index: text.length - 1,
                  url: redirectUrl,
                  title: "cbsnews.com",
                },
              ],
              citationUrlsByIndex: new Map([[1, redirectUrl]]),
            },
            text,
          ),
        );
      });

      const chipButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("cbsnews.com"));
      if (!chipButton) {
        throw new Error("missing Google citation chip button");
      }

      await act(async () => {
        chipButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const popupText = harness.dom.window.document.body.textContent ?? "";
      expect(popupText).toContain("cbsnews.com");
      expect(popupText).not.toContain("vertexaisearch.cloud.google.com");
      expect(popupText).not.toContain("grounding-api-redirect");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
