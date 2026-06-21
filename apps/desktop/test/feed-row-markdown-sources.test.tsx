import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import type { CitationSource } from "../../../src/shared/displayCitationMarkers";
import type { SessionFeedItem } from "../../../src/shared/sessionSnapshot";
import { ChatViewContext } from "../src/ui/chat/ChatViewContext";
import type { MentionCatalog } from "../src/ui/chat/composerMentions";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const confirmActionMock = mock(async () => true);

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    confirmAction: confirmActionMock,
  }),
);

const { FeedRow } = await import("../src/ui/chat/FeedRow");

const EMPTY_MENTION_CATALOG: MentionCatalog = {
  items: [],
  names: [],
  kindByName: new Map(),
};

function renderFeedRow(
  item: SessionFeedItem,
  props: {
    citationSources?: CitationSource[];
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
      a2uiEnabled: false,
      ...props,
    }),
  );
}

describe("FeedRow assistant markdown and sources integration", () => {
  test("wires assistant markdown file links and source cards through desktop-safe handlers", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const originalWindowOpen = harness.dom.window.open;
    const openSpy = mock(() => null);
    harness.dom.window.open = openSpy as typeof harness.dom.window.open;
    confirmActionMock.mockClear();
    confirmActionMock.mockImplementation(async () => true);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          renderFeedRow(
            {
              id: "assistant-file-source",
              kind: "message",
              role: "assistant",
              ts: "2026-06-18T10:00:00.000Z",
              text: "Saved the analysis as [Portfolio_Report.docx](Portfolio_Report.docx).",
            },
            {
              desktopBasePath: "/Users/test/.cowork/chats/chat-1/outputs",
              citationSources: [
                {
                  title: "Portfolio Methodology",
                  url: "https://example.com/research/portfolio-methodology",
                },
              ],
            },
          ),
        );
      });

      const fileButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Portfolio_Report.docx"),
      );
      expect(fileButton).toBeTruthy();
      expect(container.querySelector('a[href="Portfolio_Report.docx"]')).toBeNull();
      expect(container.textContent).toContain("Sources");

      const sourceButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Portfolio Methodology"),
      );
      if (!sourceButton) {
        throw new Error("missing source button");
      }

      await act(async () => {
        sourceButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      expect(confirmActionMock).toHaveBeenCalledTimes(1);
      expect(confirmActionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: "https://example.com/research/portfolio-methodology",
          title: "Open external link?",
        }),
      );
      expect(openSpy).toHaveBeenCalledWith(
        "https://example.com/research/portfolio-methodology",
        "_blank",
        "noopener,noreferrer",
      );

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.dom.window.open = originalWindowOpen;
      harness.restore();
    }
  });

  test("does not duplicate the sources carousel when assistant annotations render inline chips", () => {
    const text = "The filing confirms the new policy.";
    const html = renderToStaticMarkup(
      renderFeedRow(
        {
          id: "assistant-inline-citation",
          kind: "message",
          role: "assistant",
          ts: "2026-06-18T10:01:00.000Z",
          text,
          annotations: [
            {
              type: "url_citation",
              start_index: 0,
              end_index: text.length,
              url: "https://example.com/research/filing",
            },
          ],
        },
        {
          citationSources: [
            {
              title: "Policy Filing",
              url: "https://example.com/research/filing",
            },
          ],
        },
      ),
    );

    expect(html).toContain("Policy Filing");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain(">Sources<");
  });
});
