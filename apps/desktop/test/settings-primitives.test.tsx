import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { EntityIcon, SettingsStatusPill } from "../src/ui/settings/SettingsPrimitives";
import { setupJsdom } from "./jsdomHarness";

describe("settings primitives", () => {
  test("uses readable foreground text for success status pills", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsStatusPill, { tone: "success" }, "Connected"),
    );

    expect(html).toContain("text-foreground");
    expect(html).not.toContain("text-success");
  });

  test("EntityIcon retries image rendering when src changes after an error", async () => {
    const harness = setupJsdom();

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");

      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(EntityIcon, {
            src: "https://example.test/broken-icon.png",
            name: "Example Provider",
          }),
        );
      });

      const brokenImage = harness.dom.window.document.querySelector("img");
      if (!(brokenImage instanceof harness.dom.window.HTMLImageElement)) {
        throw new Error("missing initial image");
      }

      await act(async () => {
        brokenImage.dispatchEvent(new harness.dom.window.Event("error"));
      });

      expect(harness.dom.window.document.querySelector("img")).toBeNull();
      expect(harness.dom.window.document.body.textContent).toContain("EP");

      await act(async () => {
        root.render(
          createElement(EntityIcon, {
            src: "https://example.test/working-icon.png",
            name: "Example Provider",
          }),
        );
      });

      const workingImage = harness.dom.window.document.querySelector("img");
      if (!(workingImage instanceof harness.dom.window.HTMLImageElement)) {
        throw new Error("missing retried image");
      }

      expect(workingImage.getAttribute("src")).toBe("https://example.test/working-icon.png");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
