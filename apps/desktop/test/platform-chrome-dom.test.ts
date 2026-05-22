import { describe, expect, test } from "bun:test";

import type { PlatformChromeInfo } from "../src/lib/desktopApi";
import { applyPlatformChromeToDocument, syncPlatformChromeCssVars } from "../src/lib/platformChromeDom";
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
        collapsedLeftRailWidth: 84,
        topbarToolbarGap: 6,
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
      expect(root.style.getPropertyValue("--platform-collapsed-left-rail-width")).toBe("84px");
      expect(root.style.getPropertyValue("--platform-topbar-toolbar-gap")).toBe("6px");
      expect(root.dataset.sidebarTitlebandMode).toBe("native");
      expect(root.dataset.topbarControlPlacement).toBe("left-rail");
      expect(root.dataset.captionButtonReserve).toBe("136");
      expect(root.dataset.collapsedLeftRailWidth).toBe("84");
      expect(root.dataset.topbarToolbarGap).toBe("6");
      expect(root.dataset.usesNativeGlass).toBe("false");
      expect(root.dataset.disableCssBlur).toBe("true");
    } finally {
      harness.restore();
    }
  });

  test("syncPlatformChromeCssVars applies platform defaults before IPC chrome arrives", () => {
    const harness = setupJsdom();
    try {
      harness.dom.window.document.documentElement.dataset.platform = "win32";
      syncPlatformChromeCssVars(harness.dom.window.document);

      const root = harness.dom.window.document.documentElement;
      expect(root.style.getPropertyValue("--platform-caption-button-reserve")).toBe("136px");
      expect(root.style.getPropertyValue("--platform-collapsed-left-rail-width")).toBe("84px");
      expect(root.style.getPropertyValue("--platform-topbar-toolbar-gap")).toBe("6px");
    } finally {
      harness.restore();
    }
  });
});
