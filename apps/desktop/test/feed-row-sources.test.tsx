import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { CitationSource } from "../../../src/shared/displayCitationMarkers";
import type { FeedItem } from "../src/app/types";
import { ChatViewContext } from "../src/ui/chat/ChatViewContext";
import type { MentionCatalog } from "../src/ui/chat/composerMentions";
import { setupJsdom } from "./jsdomHarness";

const openExternalSourceMock = mock(async (_url: string) => {});

mock.module("../src/lib/openExternalSource", () => ({
  openExternalSource: openExternalSourceMock,
}));

const { FeedRow } = await import("../src/ui/chat/FeedRow");

const EMPTY_CATALOG: MentionCatalog = { items: [], names: [], kindByName: new Map() };

function renderFeedRow() {
  const harness = setupJsdom({ includeAnimationFrame: true });
  const container = harness.dom.window.document.getElementById("root");
  if (!container) throw new Error("missing root");

  const root = createRoot(container);

  return { container, harness, root };
}

async function mountFeedRow({
  container,
  root,
  item,
  citationSources,
}: {
  container: Element;
  root: ReturnType<typeof createRoot>;
  item: FeedItem;
  citationSources: CitationSource[];
}) {
  await act(async () => {
    root.render(
      createElement(
        ChatViewContext.Provider,
        { value: { developerMode: false, mentionCatalog: EMPTY_CATALOG } },
        createElement(FeedRow, {
          item,
          citationSources,
          a2uiEnabled: true,
        }),
      ),
    );
  });

  return container;
}

describe("FeedRow citation source footer", () => {
  test("wires footer source clicks through the external source opener", async () => {
    const item: FeedItem = {
      id: "msg-1",
      kind: "message",
      role: "assistant",
      ts: "2026-03-12T00:00:30.000Z",
      text: "I found supporting reports.",
    };
    const citationSources = [
      { title: "Collision Report", url: "https://example.com/collision" },
      { title: "Safety Memo", url: "https://example.com/safety" },
    ];
    const { container, harness, root } = renderFeedRow();
    openExternalSourceMock.mockClear();

    try {
      await mountFeedRow({ container, root, item, citationSources });

      expect(container.textContent).toContain("Sources");
      const sourceButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Safety Memo"),
      );
      if (!sourceButton) {
        throw new Error("missing source footer button");
      }

      await act(async () => {
        sourceButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(openExternalSourceMock).toHaveBeenCalledTimes(1);
      expect(openExternalSourceMock).toHaveBeenCalledWith("https://example.com/safety");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("suppresses the footer carousel when assistant annotations render citation chips", async () => {
    const item: FeedItem = {
      id: "msg-2",
      kind: "message",
      role: "assistant",
      ts: "2026-03-12T00:00:30.000Z",
      text: "The collision report confirms the runway closure.",
      annotations: [
        {
          type: "url_citation",
          start_index: 0,
          end_index: "The collision report".length,
          title: "Collision Report",
          url: "https://example.com/collision",
        },
      ],
    };
    const citationSources = [
      { title: "Collision Report", url: "https://example.com/collision" },
      { title: "Safety Memo", url: "https://example.com/safety" },
    ];
    const { container, harness, root } = renderFeedRow();
    openExternalSourceMock.mockClear();

    try {
      await mountFeedRow({ container, root, item, citationSources });

      expect(container.textContent).toContain("Collision Report");
      expect(container.textContent).not.toContain("Sources");
      const footerSourceButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Safety Memo"),
      );
      expect(footerSourceButton).toBeUndefined();
      expect(openExternalSourceMock).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });
});
