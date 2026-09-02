import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as Electron from "electron";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { hostPlatform } from "../../../src/platform/host";
import {
  isPathEqualOrInsideLexical,
  type PathStyle,
  resolve as resolvePathString,
  styleFor,
} from "../../../src/platform/pathString";
import { scratchRoots } from "../../../src/platform/sandbox";
import {
  type DesktopMediaPathAdapter,
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

function lexicalMediaPathAdapter(style: PathStyle): DesktopMediaPathAdapter {
  return {
    style,
    resolveAllowedPath: (roots, requestedPath) => {
      const resolved = resolvePathString(requestedPath, style);
      if (roots.some((root) => isPathEqualOrInsideLexical(root, resolved, style))) {
        return resolved;
      }
      throw new Error("path is outside allowed workspace roots");
    },
  };
}

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
  const POSIX_PATHS = lexicalMediaPathAdapter("posix");
  const WIN32_PATHS = lexicalMediaPathAdapter("win32");
  const mediaUrl = (p: string) => `cowork-media://media?path=${encodeURIComponent(p)}`;
  const resolvePosix = (p: string, roots: string[]) =>
    resolveDesktopMediaRequestPath(mediaUrl(p), roots, POSIX_PATHS);

  test("resolves image request URLs inside an approved workspace root", () => {
    expect(resolvePosix("/Users/test/ws/chart.png", [WS_ROOT])).toBe("/Users/test/ws/chart.png");
    expect(resolvePosix("/Users/test/ws/outputs/plot.webp", [WS_ROOT])).toBe(
      "/Users/test/ws/outputs/plot.webp",
    );
    expect(
      resolveDesktopMediaRequestPath(
        mediaUrl("C:\\Users\\Test\\ws\\chart.png"),
        ["C:\\Users\\Test\\ws"],
        WIN32_PATHS,
      ),
    ).toBe("C:\\Users\\Test\\ws\\chart.png");
  });

  test("never reinterprets roots from a different path syntax", () => {
    expect(resolvePosix("/Users/test/ws/chart.png", ["C:\\Users\\test\\ws"])).toBeNull();
    expect(
      resolveDesktopMediaRequestPath(
        mediaUrl("C:\\Users\\test\\ws\\chart.png"),
        ["/Users/test/ws"],
        WIN32_PATHS,
      ),
    ).toBeNull();
  });

  test("rejects absolute image paths outside every approved root", () => {
    // The finding-1 case: rendered chat content pointing at arbitrary local images.
    expect(resolvePosix("/home/user/Pictures/private.png", [WS_ROOT])).toBeNull();
    expect(resolvePosix("/outside-root/secret.png", [])).toBeNull();
  });

  test("rejects traversal that escapes the approved root", () => {
    expect(resolvePosix("/Users/test/ws/../secret.png", [WS_ROOT])).toBeNull();
    expect(resolvePosix("/Users/test/ws/a/../../../etc/leak.png", [WS_ROOT])).toBeNull();
  });

  test("normalizes in-root traversal segments and re-validates the target", () => {
    expect(resolvePosix("/Users/test/ws/a/../chart.png", [WS_ROOT])).toBe(
      "/Users/test/ws/chart.png",
    );
    // Traversal that lands on a non-image target is rejected.
    expect(resolvePosix("/Users/test/ws/chart.png/../secrets.env", [WS_ROOT])).toBeNull();
  });

  test("allows the one-off chats home like the file IPC boundary does", () => {
    const oneOffImage = path.join(os.homedir(), ".cowork", "chats", "session-1", "chart.png");
    expect(resolveDesktopMediaRequestPath(mediaUrl(oneOffImage), [])).toBe(oneOffImage);
  });

  test("rejects non-media and malformed requests", () => {
    expect(resolvePosix("/Users/test/ws/passwd", [WS_ROOT])).toBeNull();
    expect(
      resolveDesktopMediaRequestPath("https://example.com/x.png", [WS_ROOT], POSIX_PATHS),
    ).toBeNull();
    expect(resolveDesktopMediaRequestPath("", [WS_ROOT], POSIX_PATHS)).toBeNull();
  });
});

describe("registerDesktopMediaProtocolHandler", () => {
  const HOST_PATH_STYLE = styleFor(hostPlatform());
  const HOST_SCRATCH_ROOT = scratchRoots(hostPlatform())[0];
  if (!HOST_SCRATCH_ROOT) throw new Error("host platform has no scratch root");
  let temporaryRoot: string;
  let workspaceRoot: string;
  let imagePath: string;
  const mediaUrl = (p: string) => `cowork-media://media?path=${encodeURIComponent(p)}`;

  type MediaHandler = (request: Request) => Promise<Response>;

  beforeEach(async () => {
    temporaryRoot = await fs.realpath(
      await fs.mkdtemp(path.join(HOST_SCRATCH_ROOT, "cowork-media-handler-")),
    );
    workspaceRoot = path.join(temporaryRoot, "ws");
    imagePath = path.join(workspaceRoot, "chart.png");
    await fs.mkdir(workspaceRoot);
    await fs.writeFile(imagePath, "PNGDATA");
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  function setupHandler(roots: string[], opts?: { ensureRejects?: boolean }) {
    let handler: MediaHandler | undefined;
    const protocol = {
      handle: (_scheme: string, fn: MediaHandler) => {
        handler = fn;
      },
    } as unknown as Electron.Protocol;
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
    registerDesktopMediaProtocolHandler(protocol, workspaceRoots);
    if (!handler) {
      throw new Error("protocol handler was not registered");
    }
    return { handler, wasEnsured: () => ensured };
  }

  test("serves images inside approved workspace roots", async () => {
    const { handler, wasEnsured } = setupHandler([workspaceRoot]);
    const response = await handler(new Request(mediaUrl(imagePath)));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(await response.text()).toBe("PNGDATA");
    expect(wasEnsured()).toBe(true);
  });

  test("rejects foreign-style paths before opening files", async () => {
    const foreignRoot = HOST_PATH_STYLE === "win32" ? "/Users/test/ws" : "C:\\Users\\Test\\ws";
    const foreignImage =
      HOST_PATH_STYLE === "win32" ? `${foreignRoot}/chart.png` : `${foreignRoot}\\chart.png`;
    const open = spyOn(fs, "open");
    try {
      const { handler } = setupHandler([foreignRoot]);
      const response = await handler(new Request(mediaUrl(foreignImage)));
      expect(response.status).toBe(404);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  test("returns 404 without touching disk for out-of-root images", async () => {
    const open = spyOn(fs, "open");
    try {
      const { handler } = setupHandler([workspaceRoot]);
      const response = await handler(
        new Request(mediaUrl(path.join(HOST_SCRATCH_ROOT, "outside-workspace", "private.png"))),
      );
      expect(response.status).toBe(404);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  test("returns 404 when approved roots cannot be loaded", async () => {
    const open = spyOn(fs, "open");
    try {
      const { handler } = setupHandler([workspaceRoot], { ensureRejects: true });
      const response = await handler(new Request(mediaUrl(imagePath)));
      expect(response.status).toBe(404);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  test.skipIf(hostPlatform() === "win32")(
    "rejects an image replaced by an outside symlink between authorization and open",
    async () => {
      const outsidePath = path.join(temporaryRoot, "outside.txt");
      await fs.writeFile(outsidePath, "OUTSIDE");
      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      const open = spyOn(fs, "open").mockImplementation(async (targetPath, flags, mode) => {
        if (targetPath === imagePath && !replaced) {
          replaced = true;
          await fs.rename(imagePath, `${imagePath}.old`);
          await fs.symlink(outsidePath, imagePath);
        }
        return originalOpen(targetPath, flags, mode);
      });

      try {
        const { handler } = setupHandler([workspaceRoot]);
        const response = await handler(new Request(mediaUrl(imagePath)));

        expect(replaced).toBe(true);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("OUTSIDE");
      } finally {
        open.mockRestore();
      }
    },
  );

  test.skipIf(hostPlatform() === "win32")(
    "rejects an ancestor replaced by an outside symlink before the file opens",
    async () => {
      const outsideRoot = path.join(temporaryRoot, "outside");
      await fs.mkdir(outsideRoot);
      await fs.writeFile(path.join(outsideRoot, "chart.png"), "OUTSIDE");
      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      const open = spyOn(fs, "open").mockImplementation(async (targetPath, flags, mode) => {
        if (targetPath === imagePath && !replaced) {
          replaced = true;
          await fs.rename(workspaceRoot, `${workspaceRoot}.old`);
          await fs.symlink(outsideRoot, workspaceRoot);
        }
        return originalOpen(targetPath, flags, mode);
      });

      try {
        const { handler } = setupHandler([workspaceRoot]);
        const response = await handler(new Request(mediaUrl(imagePath)));

        expect(replaced).toBe(true);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("OUTSIDE");
      } finally {
        open.mockRestore();
      }
    },
  );

  test.each([
    ["bytes=1-3", "NGD", "bytes 1-3/7"],
    ["bytes=4-", "ATA", "bytes 4-6/7"],
    ["bytes=-2", "TA", "bytes 5-6/7"],
  ])("serves the requested byte range %s", async (range, body, contentRange) => {
    const { handler } = setupHandler([workspaceRoot]);
    const response = await handler(new Request(mediaUrl(imagePath), { headers: { Range: range } }));

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Content-Length")).toBe(String(body.length));
    expect(await response.text()).toBe(body);
  });

  test("returns the resource length for an unsatisfiable range", async () => {
    const { handler } = setupHandler([workspaceRoot]);
    const response = await handler(
      new Request(mediaUrl(imagePath), { headers: { Range: "bytes=99-" } }),
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */7");
    expect(await response.text()).toBe("");
  });

  test("returns the complete image when an If-Range validator cannot be matched", async () => {
    const { handler } = setupHandler([workspaceRoot]);
    const response = await handler(
      new Request(mediaUrl(imagePath), {
        headers: { Range: "bytes=1-3", "If-Range": '"stale-version"' },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("PNGDATA");
  });

  test("HEAD reports image metadata without a response body", async () => {
    const { handler } = setupHandler([workspaceRoot]);
    const response = await handler(new Request(mediaUrl(imagePath), { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe("7");
    expect(response.body).toBeNull();
  });

  test.each(["bytes=1-2,4-5", "items=0-1", "bytes=invalid"])(
    "ignores unsupported or malformed ranges %s",
    async (range) => {
      const { handler } = setupHandler([workspaceRoot]);
      const response = await handler(
        new Request(mediaUrl(imagePath), { headers: { Range: range } }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Length")).toBe("7");
      expect(await response.text()).toBe("PNGDATA");
    },
  );

  test("serves an empty file without creating an invalid stream range", async () => {
    await fs.writeFile(imagePath, "");
    const { handler } = setupHandler([workspaceRoot]);
    const response = await handler(new Request(mediaUrl(imagePath)));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("0");
    expect(await response.text()).toBe("");
  });

  test("closes the file when the media request is aborted", async () => {
    await fs.writeFile(imagePath, Buffer.alloc(1024 * 1024, 0x41));
    const originalOpen = fs.open.bind(fs);
    const closed = Promise.withResolvers<void>();
    const open = spyOn(fs, "open").mockImplementation(async (targetPath, flags, mode) => {
      const file = await originalOpen(targetPath, flags, mode);
      if (targetPath === imagePath) {
        file.once("close", () => closed.resolve());
      }
      return file;
    });
    const controller = new AbortController();

    try {
      const { handler } = setupHandler([workspaceRoot]);
      const response = await handler(
        new Request(mediaUrl(imagePath), { signal: controller.signal }),
      );
      expect(response.status).toBe(200);
      const reading = response.arrayBuffer();
      controller.abort();

      await expect(reading).rejects.toThrow();
      await closed.promise;
    } finally {
      open.mockRestore();
    }
  });

  test("streams large images in bounded chunks and closes the file on cancellation", async () => {
    const contents = Buffer.alloc(1024 * 1024, 0x41);
    await fs.writeFile(imagePath, contents);
    const originalOpen = fs.open.bind(fs);
    const closed = Promise.withResolvers<void>();
    const open = spyOn(fs, "open").mockImplementation(async (targetPath, flags, mode) => {
      const file = await originalOpen(targetPath, flags, mode);
      if (targetPath === imagePath) {
        file.once("close", () => closed.resolve());
      }
      return file;
    });

    try {
      const { handler } = setupHandler([workspaceRoot]);
      const response = await handler(new Request(mediaUrl(imagePath)));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Length")).toBe(String(contents.length));
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader?.read();
      expect(first?.value?.byteLength).toBeGreaterThan(0);
      expect(first?.value?.byteLength).toBeLessThan(contents.length);
      await reader?.cancel();
      await closed.promise;
    } finally {
      open.mockRestore();
    }
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

  test("resolves workspace-relative raw HTML images against desktopBasePath", () => {
    const html = renderToStaticMarkup(
      createElement(
        DesktopMarkdown,
        { desktopBasePath: "/Users/test/ws" },
        '<img src="outputs/plot.png" alt="raw rel">',
      ),
    );

    expect(html).toContain(
      `src="cowork-media://media?path=${encodeURIComponent("/Users/test/ws/outputs/plot.png")}"`,
    );
  });

  test("does not build cowork-media URLs for raw HTML images escaping desktopBasePath", () => {
    const html = renderToStaticMarkup(
      createElement(
        DesktopMarkdown,
        { desktopBasePath: "/Users/test/ws" },
        '<img src="../outside/secret.png" alt="escape">',
      ),
    );

    expect(html).not.toContain("cowork-media:");
    expect(html).not.toContain("outside%2Fsecret");
    // The blocked src must be dropped, not fall back to the raw escaping path.
    expect(html).not.toContain("../outside/secret.png");
    expect(html).not.toContain("secret.png");
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
