import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { resolveDesktopMediaRequestPath } from "../electron/services/mediaProtocol";
import {
  decodeDesktopMediaUrl,
  desktopMediaMimeType,
  encodeDesktopMediaUrl,
  isAbsoluteDesktopPath,
} from "../src/lib/mediaProtocol";
import { DesktopMarkdown, rewriteDesktopImageUrl } from "../src/ui/markdown";

describe("cowork-media protocol helpers", () => {
  test("encodes absolute image paths into cowork-media URLs", () => {
    expect(encodeDesktopMediaUrl("/Users/test/chart.png")).toBe(
      "cowork-media://media?path=%2FUsers%2Ftest%2Fchart.png",
    );
    expect(encodeDesktopMediaUrl("C:\\Users\\Test\\chart.png")).toBe(
      "cowork-media://media?path=C%3A%5CUsers%5CTest%5Cchart.png",
    );
  });

  test("rejects non-image and relative paths", () => {
    expect(encodeDesktopMediaUrl("/Users/test/report.pdf")).toBeNull();
    expect(encodeDesktopMediaUrl("/Users/test/no-extension")).toBeNull();
    expect(encodeDesktopMediaUrl("relative/chart.png")).toBeNull();
  });

  test("round-trips encode/decode", () => {
    const paths = [
      "/Users/test/My Charts/plot (v2).png",
      "C:\\Users\\Test\\Desktop\\image.webp",
      "\\\\server\\share\\photo.jpeg",
    ];
    for (const path of paths) {
      const url = encodeDesktopMediaUrl(path);
      expect(url).not.toBeNull();
      expect(decodeDesktopMediaUrl(url)).toBe(path);
    }
  });

  test("decode rejects other protocols, non-images, and malformed URLs", () => {
    expect(decodeDesktopMediaUrl("cowork-file://open?path=%2Ffoo.png")).toBeNull();
    expect(decodeDesktopMediaUrl("https://example.com/foo.png")).toBeNull();
    expect(decodeDesktopMediaUrl("cowork-media://media?path=%2Ffoo.pdf")).toBeNull();
    expect(decodeDesktopMediaUrl("cowork-media://media")).toBeNull();
    expect(decodeDesktopMediaUrl("not a url")).toBeNull();
    expect(decodeDesktopMediaUrl(null)).toBeNull();
  });

  test("isAbsoluteDesktopPath covers posix, drive, and UNC forms", () => {
    expect(isAbsoluteDesktopPath("/Users/test/a.png")).toBe(true);
    expect(isAbsoluteDesktopPath("C:\\a.png")).toBe(true);
    expect(isAbsoluteDesktopPath("c:/a.png")).toBe(true);
    expect(isAbsoluteDesktopPath("\\\\server\\share\\a.png")).toBe(true);
    expect(isAbsoluteDesktopPath("relative/a.png")).toBe(false);
    expect(isAbsoluteDesktopPath("a.png")).toBe(false);
  });

  test("maps image extensions to mime types", () => {
    expect(desktopMediaMimeType("/a/b.png")).toBe("image/png");
    expect(desktopMediaMimeType("/a/b.svg")).toBe("image/svg+xml");
    expect(desktopMediaMimeType("/a/b.avif")).toBe("image/avif");
  });
});

describe("resolveDesktopMediaRequestPath", () => {
  test("resolves valid image request URLs to absolute paths", () => {
    expect(
      resolveDesktopMediaRequestPath("cowork-media://media?path=%2FUsers%2Ftest%2Fchart.png"),
    ).toBe("/Users/test/chart.png");
  });

  test("normalizes traversal segments and re-validates the target", () => {
    expect(
      resolveDesktopMediaRequestPath(
        `cowork-media://media?path=${encodeURIComponent("/Users/test/../test/chart.png")}`,
      ),
    ).toBe("/Users/test/chart.png");
    // Traversal that lands on a non-image target is rejected.
    expect(
      resolveDesktopMediaRequestPath(
        `cowork-media://media?path=${encodeURIComponent("/Users/test/chart.png/../secrets.env")}`,
      ),
    ).toBeNull();
  });

  test("rejects non-media and malformed requests", () => {
    expect(resolveDesktopMediaRequestPath("cowork-media://media?path=%2Fetc%2Fpasswd")).toBeNull();
    expect(resolveDesktopMediaRequestPath("https://example.com/x.png")).toBeNull();
    expect(resolveDesktopMediaRequestPath("")).toBeNull();
  });
});

describe("rewriteDesktopImageUrl", () => {
  test("rewrites absolute paths to cowork-media", () => {
    expect(rewriteDesktopImageUrl("/Users/test/chart.png")).toBe(
      "cowork-media://media?path=%2FUsers%2Ftest%2Fchart.png",
    );
  });

  test("rewrites file:// URLs to cowork-media", () => {
    expect(rewriteDesktopImageUrl("file:///Users/test/My%20Charts/plot.png")).toBe(
      `cowork-media://media?path=${encodeURIComponent("/Users/test/My Charts/plot.png")}`,
    );
  });

  test("resolves workspace-relative paths against the base path", () => {
    expect(rewriteDesktopImageUrl("outputs/plot.png", "/Users/test/ws")).toBe(
      `cowork-media://media?path=${encodeURIComponent("/Users/test/ws/outputs/plot.png")}`,
    );
    expect(rewriteDesktopImageUrl("./outputs/plot.png", "/Users/test/ws")).toBe(
      `cowork-media://media?path=${encodeURIComponent("/Users/test/ws/outputs/plot.png")}`,
    );
    expect(rewriteDesktopImageUrl("outputs/plot.png", null)).toBeNull();
  });

  test("leaves remote and data URLs untouched", () => {
    expect(rewriteDesktopImageUrl("https://example.com/pic.jpg")).toBeNull();
    expect(rewriteDesktopImageUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(rewriteDesktopImageUrl("cowork-media://media?path=%2Fa.png")).toBeNull();
  });

  test("leaves non-image local paths untouched", () => {
    expect(rewriteDesktopImageUrl("/Users/test/report.pdf")).toBeNull();
  });
});

describe("DesktopMarkdown inline images", () => {
  test("renders local absolute-path markdown images via cowork-media", () => {
    const html = renderToStaticMarkup(
      createElement(DesktopMarkdown, null, "![TPU chart](/Users/test/chart.png)"),
    );

    expect(html).toContain('src="cowork-media://media?path=%2FUsers%2Ftest%2Fchart.png"');
    expect(html).toContain('alt="TPU chart"');
    expect(html).not.toContain("cowork-file:");
  });

  test("renders https markdown images untouched", () => {
    const html = renderToStaticMarkup(
      createElement(DesktopMarkdown, null, "![remote](https://example.com/pic.jpg)"),
    );

    expect(html).toContain('src="https://example.com/pic.jpg"');
  });

  test("resolves workspace-relative markdown images against desktopBasePath", () => {
    const html = renderToStaticMarkup(
      createElement(
        DesktopMarkdown,
        { desktopBasePath: "/Users/test/ws" },
        "![rel](outputs/plot.png)",
      ),
    );

    expect(html).toContain(
      `src="cowork-media://media?path=${encodeURIComponent("/Users/test/ws/outputs/plot.png")}"`,
    );
  });

  test("sanitizes raw HTML images but keeps cowork-media and https sources", () => {
    const html = renderToStaticMarkup(
      createElement(
        DesktopMarkdown,
        null,
        '<img src="/Users/test/photo.jpeg" alt="raw"> and <img src="https://example.com/x.png" alt="net">',
      ),
    );

    expect(html).toContain(
      `src="cowork-media://media?path=${encodeURIComponent("/Users/test/photo.jpeg")}"`,
    );
    expect(html).toContain('src="https://example.com/x.png"');
  });

  test("keeps non-image markdown paths as file chips, not images", () => {
    const html = renderToStaticMarkup(
      createElement(DesktopMarkdown, null, "[doc](/Users/test/report.pdf)"),
    );

    expect(html).toContain("<button");
    expect(html).not.toContain("<img");
  });
});

describe("DesktopMarkdown mermaid fences", () => {
  test("mermaid fences route to the diagram renderer instead of inline code", () => {
    const html = renderToStaticMarkup(
      createElement(DesktopMarkdown, null, "```mermaid\ngraph TD; A-->B;\n```"),
    );

    // The mermaid path suspends behind a lazy chunk in SSR, so the reliable
    // signal is that the fence did not fall through to the inline-code path.
    expect(html).not.toContain('data-streamdown="inline-code"');
    expect(html).not.toContain("language-mermaid");
    expect(html).not.toContain("Copy code");
  });

  test("non-mermaid fences keep the hover copy button", () => {
    const html = renderToStaticMarkup(
      createElement(DesktopMarkdown, null, "```ts\nconst x = 1;\n```"),
    );

    expect(html).toContain('data-streamdown="inline-code"');
    expect(html).toContain("Copy code");
  });
});
