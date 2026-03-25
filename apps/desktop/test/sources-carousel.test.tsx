import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const confirmActionMock = mock(async () => true);

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock({
  confirmAction: confirmActionMock,
}));

const { SourcesCarousel } = await import("../src/components/ai-elements/sources-carousel");

describe("desktop sources carousel", () => {
  test("renders nothing when no sources are available", () => {
    const html = renderToStaticMarkup(createElement(SourcesCarousel, { sources: [] }));
    expect(html).toBe("");
  });

  test("opens a source in the browser after confirmation", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const originalWindowOpen = harness.dom.window.open;
    const openSpy = mock(() => null);
    harness.dom.window.open = openSpy as typeof harness.dom.window.open;
    confirmActionMock.mockClear();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(SourcesCarousel, {
            sources: [{ title: "HeroUI Migration", url: "https://example.com/articles/hero-ui-migration-guide" }],
          }),
        );
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

      expect(confirmActionMock).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith(
        "https://example.com/articles/hero-ui-migration-guide",
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
});
