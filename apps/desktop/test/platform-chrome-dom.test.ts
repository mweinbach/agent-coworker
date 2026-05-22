import { describe, expect, test } from "bun:test";

import type { PlatformChromeInfo } from "../src/lib/desktopApi";
import { applyPlatformChromeToDocument } from "../src/lib/platformChromeDom";
import { setupJsdom } from "./jsdomHarness";

describe("applyPlatformChromeToDocument", () => {
  test("projects platform chrome layout metrics and flags onto the document root", () => {
    const harness = setupJsdom();
    try {
      const chrome: PlatformChromeInfo = {
        platform: "windows",
        titlebarHeight: 37,
        dragStripHeight: 11,
        leftNativeReserve: 13,
        rightNativeReserve: 17,
        captionButtonReserve: 136,
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "left-rail",
        usesNativeGlass: false,
        disableCssBlur: true,
      };

      applyPlatformChromeToDocument(harness.dom.window.document, chrome);

      const root = harness.dom.window.document.documentElement;
      expect(root.style.getPropertyValue("--platform-titlebar-height")).toBe("37px");
      expect(root.style.getPropertyValue("--platform-drag-strip-height")).toBe("11px");
      expect(root.style.getPropertyValue("--platform-left-native-reserve")).toBe("13px");
      expect(root.style.getPropertyValue("--platform-right-native-reserve")).toBe("17px");
      expect(root.style.getPropertyValue("--platform-caption-button-reserve")).toBe("136px");
      expect(root.dataset.sidebarTitlebandMode).toBe("native");
      expect(root.dataset.topbarControlPlacement).toBe("left-rail");
      expect(root.dataset.usesNativeGlass).toBe("false");
      expect(root.dataset.disableCssBlur).toBe("true");
    } finally {
      harness.restore();
    }
  });
});
