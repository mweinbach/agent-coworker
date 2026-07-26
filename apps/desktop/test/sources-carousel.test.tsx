import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const confirmActionMock = mock(async () => true);

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    confirmAction: confirmActionMock,
  }),
);

const { CitationSourcesCarousel } = await import("../src/ui/chat/CitationSourcesCarousel");
const { openExternalSource } = await import("../src/lib/openExternalSource");

describe("desktop sources carousel", () => {
  test("renders nothing when no sources are available", () => {
    const html = renderToStaticMarkup(createElement(CitationSourcesCarousel, { sources: [] }));
    expect(html).toBe("");
  });

  test("starts collapsed behind a Sources button", () => {
    const html = renderToStaticMarkup(
      createElement(CitationSourcesCarousel, {
        sources: [
          {
            title: "HeroUI Migration",
            url: "https://example.com/articles/hero-ui-migration-guide",
          },
          {
            title: "Other",
            url: "https://example.com/other",
          },
        ],
      }),
    );

    expect(html).toContain('data-slot="citation-sources-trigger"');
    expect(html).toContain("Sources");
    expect(html).toContain("2");
    expect(html).toContain('aria-label="Show 2 sources"');
    // Cards stay collapsed until the user expands the control.
    expect(html).not.toContain("HeroUI Migration");
  });

  test("expands into cards and invokes onOpenSource when a card is clicked", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const onOpenSource = mock((_url: string) => {});

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(CitationSourcesCarousel, {
            sources: [
              {
                title: "HeroUI Migration",
                url: "https://example.com/articles/hero-ui-migration-guide",
              },
            ],
            onOpenSource,
          }),
        );
      });

      const trigger = container.querySelector(
        '[data-slot="citation-sources-trigger"]',
      ) as HTMLButtonElement | null;
      if (!trigger) throw new Error("missing sources trigger");

      expect(container.textContent).not.toContain("HeroUI Migration");

      await act(async () => {
        trigger.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      const sourceButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("HeroUI Migration"),
      );
      if (!sourceButton) {
        throw new Error("missing source button");
      }

      await act(async () => {
        sourceButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(onOpenSource).toHaveBeenCalledTimes(1);
      expect(onOpenSource).toHaveBeenCalledWith(
        "https://example.com/articles/hero-ui-migration-guide",
      );

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});

describe("openExternalSource", () => {
  test("opens a source in the browser after confirmation", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const originalWindowOpen = harness.dom.window.open;
    const openSpy = mock(() => null);
    harness.dom.window.open = openSpy as typeof harness.dom.window.open;
    confirmActionMock.mockClear();
    confirmActionMock.mockImplementation(async () => true);

    try {
      await openExternalSource("https://example.com/articles/hero-ui-migration-guide");

      expect(confirmActionMock).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith(
        "https://example.com/articles/hero-ui-migration-guide",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      harness.dom.window.open = originalWindowOpen;
      harness.restore();
    }
  });

  test("does not open the browser when the user cancels", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const originalWindowOpen = harness.dom.window.open;
    const openSpy = mock(() => null);
    harness.dom.window.open = openSpy as typeof harness.dom.window.open;
    confirmActionMock.mockClear();
    confirmActionMock.mockImplementation(async () => false);

    try {
      await openExternalSource("https://example.com/x");

      expect(confirmActionMock).toHaveBeenCalledTimes(1);
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      harness.dom.window.open = originalWindowOpen;
      harness.restore();
      confirmActionMock.mockImplementation(async () => true);
    }
  });
});
