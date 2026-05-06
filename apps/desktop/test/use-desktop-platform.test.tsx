import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { useDesktopPlatform } from "../src/lib/useDesktopPlatform";
import { setupJsdom } from "./jsdomHarness";

function PlatformProbe() {
  const info = useDesktopPlatform();

  return createElement("output", { "data-testid": "platform-info" }, JSON.stringify(info));
}

function readProbeInfo(container: Element) {
  const output = container.querySelector('[data-testid="platform-info"]');
  if (!output?.textContent) throw new Error("missing platform probe output");
  return JSON.parse(output.textContent) as ReturnType<typeof useDesktopPlatform>;
}

describe("useDesktopPlatform", () => {
  test("updates when async platform chrome attributes arrive on the document root", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");

      document.documentElement.dataset.platform = "win32";

      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(PlatformProbe));
      });

      expect(readProbeInfo(container)).toMatchObject({
        platform: "windows",
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "left-rail",
        usesNativeGlass: false,
        disableCssBlur: false,
      });

      await act(async () => {
        document.documentElement.dataset.sidebarTitlebandMode = "topbar";
        document.documentElement.dataset.topbarControlPlacement = "inline";
        document.documentElement.dataset.usesNativeGlass = "true";
        document.documentElement.dataset.disableCssBlur = "true";
        await Promise.resolve();
      });

      expect(readProbeInfo(container)).toMatchObject({
        platform: "windows",
        sidebarTitlebandMode: "topbar",
        topbarControlPlacement: "inline",
        usesNativeGlass: true,
        disableCssBlur: true,
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
