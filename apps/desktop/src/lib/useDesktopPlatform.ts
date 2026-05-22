import { useEffect, useState } from "react";

import { type DesktopPlatformInfo, getDesktopPlatformInfo } from "./desktopPlatform";

/**
 * React hook that returns current desktop platform info.
 *
 * Re-renders when platform data attributes on document.documentElement change
 * (e.g., when the platform chrome loads asynchronously at startup).
 */
export function useDesktopPlatform(): DesktopPlatformInfo {
  const [info, setInfo] = useState<DesktopPlatformInfo>(() => getDesktopPlatformInfo());

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
      return;
    }

    // Refresh once in case attributes were set between initial state and effect
    setInfo(getDesktopPlatformInfo());

    const observer = new MutationObserver(() => {
      setInfo(getDesktopPlatformInfo());
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        "data-platform",
        "data-sidebar-titleband-mode",
        "data-topbar-control-placement",
        "data-uses-native-glass",
        "data-disable-css-blur",
        "data-caption-button-reserve",
        "data-collapsed-left-rail-width",
        "data-topbar-toolbar-gap",
      ],
    });

    return () => observer.disconnect();
  }, []);

  return info;
}
