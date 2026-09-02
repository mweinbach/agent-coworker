import { describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import type { SessionFeedItem } from "../../../src/shared/sessionSnapshot";
import { buildCanvasDocumentPrompt } from "../src/lib/canvasRequest";
import { ChatViewContext } from "../src/ui/chat/ChatViewContext";
import type { MentionCatalog } from "../src/ui/chat/composerMentions";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const copyTextMock = mock(async (_text: string) => {});

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    copyText: copyTextMock,
  }),
);

const { FeedRow, resolveUserAttachmentPreviewSrc } = await import("../src/ui/chat/FeedRow");

const EMPTY_MENTION_CATALOG: MentionCatalog = {
  items: [],
  names: [],
  kindByName: new Map(),
};

function userMessage(id: string, text: string): SessionFeedItem {
  return {
    id,
    kind: "message",
    role: "user",
    ts: "2026-07-09T13:00:00.000Z",
    text,
  };
}

function renderFeedRow(
  item: SessionFeedItem,
  props: {
    desktopBasePath?: string | null;
  } = {},
) {
  return createElement(
    ChatViewContext.Provider,
    {
      value: {
        developerMode: false,
        mentionCatalog: EMPTY_MENTION_CATALOG,
      },
    },
    createElement(FeedRow, {
      item,
      ...props,
    }),
  );
}

function htmlFor(item: SessionFeedItem, desktopBasePath?: string | null): string {
  return renderToStaticMarkup(renderFeedRow(item, { desktopBasePath }));
}

function visibleText(html: string): string {
  return JSDOM.fragment(html).textContent ?? "";
}

async function renderInteractive(item: SessionFeedItem) {
  const harness = setupJsdom();
  const container = harness.dom.window.document.getElementById("root");
  if (!container) throw new Error("missing root");
  const root = createRoot(container);
  await act(async () => {
    root.render(renderFeedRow(item));
  });
  return { harness, container, root };
}

describe("FeedRow visible user messages", () => {
  test("labels text-only, attachment-only, mixed, and canvas turns as authored by you", () => {
    const cases = [
      userMessage("text-only", "Please summarize this thread."),
      userMessage("attachment-only", "[diagram.png]"),
      userMessage("mixed", "Please review these.\n\nAttached: [diagram.png, findings.pdf]"),
      userMessage(
        "canvas",
        buildCanvasDocumentPrompt({
          path: "/w/spec.md",
          fileName: "spec.md",
          kind: "markdown",
          selection: "Intro",
          request: "tighten this",
        }),
      ),
    ];

    for (const item of cases) {
      const html = htmlFor(item);
      expect(html).toContain('role="article"');
      expect(html).toContain('aria-label="Message from you"');
      expect(html).toContain('data-slot="message" data-align="end"');
      expect(html).toContain('data-slot="bubble" data-variant="tinted" data-align="end"');
    }
  });

  test("keeps attachment-only turns inside the user bubble with named files", () => {
    const html = htmlFor(userMessage("attachment-only", "[notes.txt, photo.png]"));
    expect(html).toContain('data-slot="bubble-content"');
    expect(html).toContain('data-slot="attachment-group"');
    expect(html).toContain('aria-label="Attached files"');
    expect(visibleText(html)).toContain("notes.txt");
    expect(visibleText(html)).toContain("photo.png");
    expect(html).not.toContain("[notes.txt, photo.png]");
  });

  test("renders image previews through cowork-media and never remote URLs", () => {
    const html = htmlFor(userMessage("images", "[diagram.png, findings.pdf]"), "/Users/test/ws");
    expect(html).toContain(
      `src="cowork-media://media?path=${encodeURIComponent("/Users/test/ws/User Uploads/diagram.png")}"`,
    );
    expect(visibleText(html)).toContain("findings.pdf");
    expect(html).not.toContain("https://");
    expect(html.match(/data-slot="attachment"/g)).toHaveLength(2);
  });

  test("renders sent spreadsheets with the same file identity as composer attachments", async () => {
    const filename = "CS_Atlas_AI_Factory_Economics_Dashboard_Canonical_V1_20260901.xlsx";
    const { harness, container, root } = await renderInteractive(
      userMessage("spreadsheet", `fact check this pls\n\nAttached: [${filename}]`),
    );

    try {
      expect(container.querySelector(".lucide-file-spreadsheet")).not.toBeNull();
      expect(container.querySelector('[data-slot="attachment-description"]')?.textContent).toBe(
        "Excel spreadsheet",
      );
      const title = container.querySelector('[data-slot="attachment-title"]');
      expect(title?.textContent).toBe(filename);
      expect(title?.lastElementChild?.textContent).toBe(".xlsx");
      expect(container.querySelector('[data-slot="attachment-action"]')).toBeNull();
      const trigger = container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]');
      if (!trigger) throw new Error("missing attachment tooltip trigger");
      await act(async () => {
        trigger.focus();
      });
      expect(harness.dom.window.document.querySelector('[role="tooltip"]')?.textContent).toBe(
        filename,
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("does not load unsafe remote image attachment names", () => {
    const html = htmlFor(
      userMessage("remote-image", "[https://evil.example/photo.png]"),
      "/Users/test/ws",
    );
    expect(visibleText(html)).toContain("photo.png");
    expect(html).not.toContain('src="https://evil.example/photo.png"');
    expect(html).not.toContain("cowork-media:");
  });

  test("renders canvas requests without leaking the stored envelope", () => {
    const html = htmlFor(
      userMessage(
        "canvas",
        buildCanvasDocumentPrompt({
          path: "/w/spec.md",
          fileName: "spec.md",
          kind: "markdown",
          selection: "The legacy intro section",
          request: "rewrite this to be concise",
        }),
      ),
    );
    expect(html).toContain("spec.md");
    expect(html).toContain("rewrite this to be concise");
    expect(html).not.toContain("canvas_request");
    expect(html).not.toContain("assistant_instructions");
  });

  test("renders malformed canvas payloads as literal text", () => {
    const html = htmlFor(userMessage("malformed-canvas", '<canvas_request version="1">broken'));
    expect(html).toContain('aria-label="Message from you"');
    expect(html).toContain("&lt;canvas_request");
    expect(html).toContain("broken");
    expect(html).not.toContain("<canvas_request version");
  });
});

describe("resolveUserAttachmentPreviewSrc", () => {
  test("encodes absolute local images and rejects remote schemes", () => {
    expect(resolveUserAttachmentPreviewSrc("/Users/test/chart.png")).toBe(
      "cowork-media://media?path=%2FUsers%2Ftest%2Fchart.png",
    );
    expect(
      resolveUserAttachmentPreviewSrc("https://evil.example/photo.png", "/Users/test/ws"),
    ).toBeNull();
    expect(resolveUserAttachmentPreviewSrc("javascript:alert(1)", "/Users/test/ws")).toBeNull();
    expect(resolveUserAttachmentPreviewSrc("../secret.png", "/Users/test/ws")).toBeNull();
  });

  test("resolves bare image filenames against the workspace uploads folder", () => {
    expect(resolveUserAttachmentPreviewSrc("diagram.png", "/Users/test/ws")).toBe(
      `cowork-media://media?path=${encodeURIComponent("/Users/test/ws/User Uploads/diagram.png")}`,
    );
  });
});

describe("FeedRow message copy", () => {
  test.each([
    "[1,2,3]",
    "[x]",
    "Explain this:\n\nAttached: is a word in this example",
    "<canvas_request>please inspect this malformed envelope",
  ])("renders and copies ambiguous text without changing it: %s", async (text) => {
    copyTextMock.mockClear();
    copyTextMock.mockImplementation(async () => {});
    const { harness, container, root } = await renderInteractive(userMessage("literal-copy", text));
    try {
      expect(container.querySelector('[data-slot="bubble-content"]')?.textContent).toBe(text);
      expect(container.querySelector('[data-slot="attachment-group"]')).toBeNull();
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy message"]',
      );
      if (!button) throw new Error("missing copy button");
      await act(async () => button.click());
      expect(copyTextMock).toHaveBeenCalledWith(text);
    } finally {
      await act(async () => root.unmount());
      harness.restore();
    }
  });

  test("copies the visible mixed-message text instead of persistence markup", async () => {
    copyTextMock.mockClear();
    copyTextMock.mockImplementation(async () => {});
    const { harness, container, root } = await renderInteractive(
      userMessage("mixed-copy", "Please review these.\n\nAttached: [diagram.png, findings.pdf]"),
    );
    try {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy message"]',
      );
      if (!button) throw new Error("missing copy button");
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      expect(copyTextMock).toHaveBeenCalledTimes(1);
      expect(copyTextMock.mock.calls[0]?.[0]).toBe(
        "Please review these.\n\nAttached: diagram.png, findings.pdf",
      );
      expect(copyTextMock.mock.calls[0]?.[0]).not.toContain("Attached: [");
      expect(button.getAttribute("aria-label")).toBe("Copied");
    } finally {
      await act(async () => root.unmount());
      harness.restore();
    }
  });

  test("copies canvas-visible content instead of the stored XML envelope", async () => {
    copyTextMock.mockClear();
    copyTextMock.mockImplementation(async () => {});
    const prompt = buildCanvasDocumentPrompt({
      path: "/w/spec.md",
      fileName: "spec.md",
      kind: "markdown",
      selection: "Intro",
      request: "tighten this",
    });
    const { harness, container, root } = await renderInteractive(
      userMessage("canvas-copy", prompt),
    );
    try {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy message"]',
      );
      if (!button) throw new Error("missing copy button");
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      const copied = String(copyTextMock.mock.calls[0]?.[0] ?? "");
      expect(copied).toContain("spec.md");
      expect(copied).toContain("tighten this");
      expect(copied).not.toContain("canvas_request");
      expect(copied).not.toContain(prompt);
    } finally {
      await act(async () => root.unmount());
      harness.restore();
    }
  });

  test("surfaces clipboard failure and keeps copy retryable", async () => {
    copyTextMock.mockClear();
    copyTextMock.mockImplementation(async () => {
      throw new Error("clipboard unavailable");
    });
    const { harness, container, root } = await renderInteractive(
      userMessage("copy-fail", "Just the text"),
    );
    try {
      const button = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy message"]',
      );
      if (!button) throw new Error("missing copy button");
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      expect(button.getAttribute("aria-label")).toBe("Copy failed. Retry.");
      expect(button.className).toContain("opacity-100");
      expect(container.textContent).toContain("Couldn't copy message. Try again.");

      copyTextMock.mockImplementation(async () => {});
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      expect(copyTextMock).toHaveBeenCalledTimes(2);
      expect(button.getAttribute("aria-label")).toBe("Copied");
    } finally {
      await act(async () => root.unmount());
      harness.restore();
    }
  });
});
