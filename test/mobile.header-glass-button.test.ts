import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const headerSource = readFileSync(
  new URL("../apps/mobile/src/components/ui/header-glass-button.tsx", import.meta.url),
  "utf8",
);

const workspaceSource = readFileSync(
  new URL("../apps/mobile/src/app/(app)/(tabs)/workspace/index.tsx", import.meta.url),
  "utf8",
);

const settingsSource = readFileSync(
  new URL("../apps/mobile/src/app/(app)/settings/index.tsx", import.meta.url),
  "utf8",
);

const pairingSource = readFileSync(
  new URL("../apps/mobile/src/app/(pairing)/_layout.tsx", import.meta.url),
  "utf8",
);

describe("mobile header glass button", () => {
  test("uses Expo SwiftUI glass controls for iOS header actions", () => {
    expect(headerSource).toContain('from "@expo/ui/swift-ui"');
    expect(headerSource).toContain("glassEffect({");
    expect(headerSource).toContain('variant: "regular"');
    expect(headerSource).toContain('shape: "circle"');
    expect(headerSource).toContain("<Host");
    expect(headerSource).toContain("<ExpoImage");
    expect(headerSource).toContain("<ExpoMenu");
  });

  test("keeps the fallback Pressable as the only non-iOS interactive glass control", () => {
    expect(headerSource).not.toContain("<GlassView isInteractive");
    expect(headerSource).toContain('pointerEvents="none"');
    expect(headerSource).toContain('glassEffectStyle="clear"');

    const pressableIndex = headerSource.indexOf("<Pressable");
    const glassIndex = headerSource.indexOf("<GlassView");

    expect(pressableIndex).toBeGreaterThanOrEqual(0);
    expect(glassIndex).toBeGreaterThan(pressableIndex);
  });

  test("uses Expo UI menu on iOS and keeps the router menu asChild fallback", () => {
    expect(workspaceSource).toContain('Platform.OS === "ios"');
    expect(workspaceSource).toContain("<HeaderGlassMenu");
    expect(workspaceSource).toContain("<Link.Trigger>");
    expect(workspaceSource).toContain('href="/(app)/(tabs)/workspace" asChild');
  });

  test("does not use the green native-stack prominent header item chrome", () => {
    expect(workspaceSource).not.toContain("unstable_headerRightItems");
    expect(settingsSource).toContain("unstable_headerRightItems: () => []");
    expect(pairingSource).toContain("unstable_headerRightItems: () => []");
    expect(workspaceSource).not.toContain('variant: "prominent"');
    expect(settingsSource).not.toContain('variant: "prominent"');
    expect(pairingSource).not.toContain('variant: "prominent"');
  });
});
