import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type PressableStyle = (state: { pressed: boolean }) => Record<string, unknown>;

let buttonStyle: PressableStyle | undefined;
let reducedMotionEnabled = false;
const originalPlatform = process.env.EXPO_OS;

function mockLocalModule(alias: string, relativePath: string, factory: () => unknown) {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(`${resolved}.ts`, factory);
  mock.module(`${resolved}.tsx`, factory);
}

const actualReactNative = require("react-native");
mockLocalModule("react-native", "apps/mobile/node_modules/react-native", () => ({
  ...actualReactNative,
  Pressable: ({ children, style }: { children: ReactNode; style: PressableStyle }) => {
    buttonStyle = style;
    return createElement("button", null, children);
  },
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
mockLocalModule("expo-glass-effect", "apps/mobile/node_modules/expo-glass-effect", () => ({
  GlassView: () => null,
  isLiquidGlassAvailable: () => true,
}));
mockLocalModule("@/components/ui/sf-symbol", "apps/mobile/src/components/ui/sf-symbol", () => ({
  SFSymbol: () => null,
}));
mockLocalModule(
  "@/features/accessibility/mobile-accessibility",
  "apps/mobile/src/features/accessibility/mobile-accessibility",
  () => ({
    MAX_DYNAMIC_TYPE_MULTIPLIER: 2,
    minimumTouchTarget: () => 48,
    useReducedMotionEnabled: () => reducedMotionEnabled,
  }),
);
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    isDark: false,
    primary: "#360",
    primaryPressed: "#240",
    primaryText: "#fff",
    primaryMuted: "#ddd",
    surfaceElevated: "#eee",
    surfaceMuted: "#ddd",
    text: "#111",
    border: "#aaa",
    borderMuted: "#bbb",
    danger: "#c00",
    dangerText: "#fff",
    accent: "#360",
    accentMuted: "#eee",
    shadow: "0 1px 2px rgba(0, 0, 0, 0.2)",
  }),
}));

const { AppButton } = await import("../apps/mobile/src/components/ui/app-button");

beforeEach(() => {
  buttonStyle = undefined;
  reducedMotionEnabled = false;
});

afterAll(() => {
  if (originalPlatform === undefined) {
    delete process.env.EXPO_OS;
  } else {
    process.env.EXPO_OS = originalPlatform;
  }
  mock.restore();
});

describe.each(["ios", "android"] as const)("AppButton transforms on %s", (platform) => {
  beforeEach(() => {
    process.env.EXPO_OS = platform;
  });

  test("clears a glass press with an empty transform list on release and cancellation", () => {
    renderToStaticMarkup(createElement(AppButton, { variant: "glass" }, "Scan QR Code"));
    expect(buttonStyle).toBeDefined();
    const style = buttonStyle!;

    expect(style({ pressed: false }).transform).toEqual([]);
    expect(style({ pressed: true }).transform).toEqual([{ scale: 0.985 }]);
    expect(style({ pressed: false }).transform).toEqual([]);
    expect(style({ pressed: true }).transform).toEqual([{ scale: 0.985 }]);
    expect(style({ pressed: false }).transform).toEqual([]);
  });

  test("keeps valid identity transforms with reduced motion enabled", () => {
    reducedMotionEnabled = true;
    renderToStaticMarkup(createElement(AppButton, { variant: "glass" }, "Connect"));
    expect(buttonStyle).toBeDefined();
    expect(buttonStyle!({ pressed: true }).transform).toEqual([]);
    expect(buttonStyle!({ pressed: false }).transform).toEqual([]);
  });

  test.each(["primary", "secondary", "destructive", "outline", "ghost", "link"] as const)(
    "%s never applies the glass press scale",
    (variant) => {
      renderToStaticMarkup(createElement(AppButton, { variant }, "Continue"));
      expect(buttonStyle).toBeDefined();
      expect(buttonStyle!({ pressed: true }).transform).toEqual([]);
      expect(buttonStyle!({ pressed: false }).transform).toEqual([]);
    },
  );
});
