import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import type * as Electron from "electron";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type DesktopMediaWorkspaceRoots,
  registerDesktopMediaProtocolHandler,
  resolveDesktopMediaRequestPath,
} from "../electron/services/mediaProtocol";
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
  const WS_ROOT = "/Users/test/ws";
  const mediaUrl = (p: string) => `cowork-media://media?path=${encodeURIComponent(p)}`;

  test("resolves image request URLs inside an approved workspace root", () => {
    expect(resolveDesktopMediaRequestPath(mediaUrl("/Users/test/ws/chart.png"), [WS_ROOT])).toBe(
      "/Users/test/ws/chart.png",
    );
    expect(
      resolveDesktopMediaRequestPath(mediaUrl("/Users/test/ws/outputs/plot.webp"), [WS_ROOT]),
    ).toBe("/Users/test/ws/outputs/plot.webp");
  });

  test("rejects absolute image paths outside every approved root", () => {
    // The finding-1 case: rendered chat content pointing at arbitrary local images.
    expect(
      resolveDesktopMediaRequestPath(mediaUrl("/home/user/Pictures/private.png"), [WS_ROOT]),
    ).toBeNull();
    expect(resolveDesktopMediaRequestPath(mediaUrl("/outside-root/secret.png"), [])).toBeNull();
  });

  test("rejects traversal that escapes the approved root", () => {
    expect(
      resolveDesktopMediaRequestPath(mediaUrl("/Users/test/ws/../secret.png"), [WS_ROOT]),
    ).toBeNull();
    expect(
      resolveDesktopMediaRequestPath(mediaUrl("/Users/test/ws/a/../../../etc/leak.png"), [WS_ROOT]),
    ).toBeNull();
  });

  test("normalizes in-root traversal segments and re-validates the target", () => {
    expect(
      resolveDesktopMediaRequestPath(mediaUrl("/Users/test/ws/a/../chart.png"), [WS_ROOT]),
    ).toBe("/Users/test/ws/chart.png");
    // Traversal that lands on a non-image target is rejected.
    expect(
      resolveDesktopMediaRequestPath(mediaUrl("/Users/test/ws/chart.png/../secrets.env"), [
        WS_ROOT,
      ]),
    ).toBeNull();
  });

  test("allows the one-off chats home like the file IPC boundary does", () => {
    const oneOffImage = path.join(os.homedir(), ".cowork", "chats", "session-1", "chart.png");
    expect(resolveDesktopMediaRequestPath(mediaUrl(oneOffImage), [])).toBe(oneOffImage);
  });

  test("rejects non-media and malformed requests", () => {
    expect(resolveDesktopMediaRequestPath(mediaUrl("/Users/test/ws/passwd"), [WS_ROOT])).toBeNull();
    expect(resolveDesktopMediaRequestPath("https://example.com/x.png", [WS_ROOT])).toBeNull();
    expect(resolveDesktopMediaRequestPath("", [WS_ROOT])).toBeNull();
  });
});

describe("registerDesktopMediaProtocolHandler", () => {
  const WS_ROOT = "/Users/test/ws";
  const mediaUrl = (p: string) => `cowork-media://media?path=${encodeURIComponent(p)}`;

  type MediaHandler = (request: Request) => Promise<Response>;

  function setupHandler(roots: string[], opts?: { ensureRejects?: boolean }) {
    let handler: MediaHandler | undefined;
    const protocol = {
      handle: (_scheme: string, fn: MediaHandler) => {
        handler = fn;
      },
    } as unknown as Electron.Protocol;
    const fetchedUrls: string[] = [];
    const net = {
      fetch: async (url: string) => {
        fetchedUrls.push(url);
        return new Response("PNGDATA", { status: 200 });
      },
    } as unknown as typeof Electron.net;
    let ensured = false;
    const workspaceRoots: DesktopMediaWorkspaceRoots = {
      ensureApprovedWorkspaceRoots: async () => {
        if (opts?.ensureRejects) {
          throw new Error("persistence unavailable");
        }
        ensured = true;
      },
      getApprovedWorkspaceRoots: () => roots,
    };
    registerDesktopMediaProtocolHandler(protocol, net, workspaceRoots);
    if (!handler) {
      throw new Error("protocol handler was not registered");
    }
    return { handler, fetchedUrls, wasEnsured: () => ensured };
  }

  test("serves images inside approved workspace roots", async () => {
    const { handler, fetchedUrls, wasEnsured } = setupHandler([WS_ROOT]);
    const response = await handler(new Request(mediaUrl("/Users/test/ws/chart.png")));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(wasEnsured()).toBe(true);
    expect(fetchedUrls).toEqual(["file:///Users/test/ws/chart.png"]);
  });

  test("returns 404 without touching disk for out-of-root images", async () => {
    const { handler, fetchedUrls } = setupHandler([WS_ROOT]);
    const response = await handler(new Request(mediaUrl("/home/user/Pictures/private.png")));
    expect(response.status).toBe(404);
    expect(fetchedUrls).toEqual([]);
  });

  test("returns 404 when approved roots cannot be loaded", async () => {
    const { handler, fetchedUrls } = setupHandler([WS_ROOT], { ensureRejects: true });
    const response = await handler(new Request(mediaUrl("/Users/test/ws/chart.png")));
    expect(response.status).toBe(404);
    expect(fetchedUrls).toEqual([]);
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

  test("rejects relative paths that escape the base path", () => {
    // The finding-2 case: "../" must not resolve outside the workspace root.
    expect(rewriteDesktopImageUrl("../outside/secret.png", "/Users/test/ws")).toBeNull();
    expect(rewriteDesktopImageUrl("outputs/../../secret.png", "/Users/test/ws")).toBeNull();
    expect(rewriteDesktopImageUrl("a/../../../etc/leak.png", "/Users/test/ws")).toBeNull();
    expect(rewriteDesktopImageUrl("..%2Foutside%2Fsecret.png", "/Users/test/ws")).toBeNull();
    expect(rewriteDesktopImageUrl("..\\outside\\secret.png", "C:\\Users\\Test\\ws")).toBeNull();
    expect(rewriteDesktopImageUrl("..", "/Users/test/ws")).toBeNull();
  });

  test("normalizes in-base traversal and redundant segments", () => {
    expect(rewriteDesktopImageUrl("outputs/../plot.png", "/Users/test/ws")).toBe(
      `cowork-media://media?path=${encodeURIComponent("/Users/test/ws/plot.png")}`,
    );
    expect(rewriteDesktopImageUrl("./outputs/./plot.png", "/Users/test/ws")).toBe(
      `cowork-media://media?path=${encodeURIComponent("/Users/test/ws/outputs/plot.png")}`,
    );
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

  test("does not build cowork-media URLs for images escaping desktopBasePath", () => {
    const html = renderToStaticMarkup(
      createElement(
        DesktopMarkdown,
        { desktopBasePath: "/Users/test/ws" },
        "![escape](../outside/secret.png) ![deep](a/../../etc/leak.png)",
      ),
    );

    expect(html).not.toContain("cowork-media:");
    expect(html).not.toContain("outside%2Fsecret");
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
