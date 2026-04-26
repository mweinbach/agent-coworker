import { describe, expect, test } from "bun:test";

import { resolveFeatureFlags } from "../../../src/shared/featureFlags";
import { getDesktopFeatureFlags } from "../src/lib/desktopCommands";

describe("desktop feature flag bridge fallback", () => {
  test("matches canonical defaults when the desktop bridge is unavailable", () => {
    expect(getDesktopFeatureFlags()).toEqual(resolveFeatureFlags({ isPackaged: false }));
  });
});
