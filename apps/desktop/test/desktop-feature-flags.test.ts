import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveFeatureFlags } from "../../../src/shared/featureFlags";

describe("desktop feature flag bridge fallback", () => {
  let originalCoworkDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    if (typeof window !== "undefined") {
      originalCoworkDescriptor = Object.getOwnPropertyDescriptor(window, "cowork");
      Object.defineProperty(window, "cowork", {
        configurable: true,
        value: undefined,
        writable: true,
      });
    }
  });

  afterEach(() => {
    if (typeof window !== "undefined") {
      if (originalCoworkDescriptor) {
        Object.defineProperty(window, "cowork", originalCoworkDescriptor);
      } else {
        delete window.cowork;
      }
    }
  });

  test("matches canonical defaults when the desktop bridge is unavailable", async () => {
    const { getDesktopFeatureFlags } = await import(
      "../src/lib/desktopCommands.ts?desktop-feature-flags-test"
    );

    expect(getDesktopFeatureFlags()).toEqual(resolveFeatureFlags({ isPackaged: false }));
  });
});
