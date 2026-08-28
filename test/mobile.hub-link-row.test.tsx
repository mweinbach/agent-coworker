import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type NativeStyle = Record<string, unknown>;
type PressableProps = {
  children: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  style?: NativeStyle | ((state: { pressed: boolean }) => NativeStyle);
  onPress?: (event: object) => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: string;
};

let platform = "android";
let pressed = false;
let pressableProps: PressableProps | undefined;
let nativeStyles: NativeStyle[] = [];
const navigations: string[] = [];
const theme = {
  borderMuted: "#aaa",
  surface: "#fff",
  surfaceMuted: "#eee",
  primaryMuted: "#ddd",
  primary: "#360",
  text: "#111",
  textSecondary: "#222",
  textTertiary: "#333",
};

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
  Platform: {
    get OS() {
      return platform;
    },
    select: (values: Record<string, unknown>) => values[platform] ?? values.default,
  },
  StyleSheet: { hairlineWidth: 0.5, flatten: (style: unknown) => style },
  Pressable: (props: PressableProps) => {
    pressableProps = props;
    const style = typeof props.style === "function" ? props.style({ pressed }) : props.style;
    if (style) nativeStyles.push(style);
    return createElement(
      "button",
      null,
      typeof props.children === "function" ? props.children({ pressed }) : props.children,
    );
  },
  View: ({ children, style }: { children: ReactNode; style?: NativeStyle }) => {
    if (style) nativeStyles.push(style);
    return createElement("div", null, children);
  },
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));
mock.module(
  path.resolve("apps/mobile/node_modules/expo-router/build/link/useLinkToPathProps.js"),
  () => ({
    default: ({ href }: { href: string }) => ({
      href,
      onPress: () => navigations.push(href),
    }),
  }),
);
mock.module(path.resolve("apps/mobile/node_modules/expo-router/build/Prefetch.js"), () => ({
  Prefetch: () => null,
}));

// Keep Expo's link and Slot composition; only replace the navigation boundary.
const { BaseExpoRouterLink } = await import(
  "../apps/mobile/node_modules/expo-router/build/link/BaseExpoRouterLink.js"
);
mockLocalModule("expo-router", "apps/mobile/node_modules/expo-router", () => ({
  Link: BaseExpoRouterLink,
}));
mockLocalModule("@/components/ui/sf-symbol", "apps/mobile/src/components/ui/sf-symbol", () => ({
  SFSymbol: () => null,
}));
mockLocalModule(
  "@/features/accessibility/mobile-accessibility",
  "apps/mobile/src/features/accessibility/mobile-accessibility",
  () => ({ MAX_DYNAMIC_TYPE_MULTIPLIER: 2, minimumTouchTarget: () => 48 }),
);
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => theme,
}));

const { HubLinkRow } = await import("../apps/mobile/src/components/ui/hub-link-row");

function renderRow(isLast = false) {
  nativeStyles = [];
  return renderToStaticMarkup(
    createElement(HubLinkRow, {
      label: "Remote access",
      description: "Pair and reconnect.",
      detail: "Connected",
      href: "/pairing",
      isLast,
    }),
  );
}

beforeEach(() => {
  pressed = false;
  pressableProps = undefined;
  nativeStyles = [];
  navigations.length = 0;
});

afterAll(() => mock.restore());

describe.each(["ios", "android"])("HubLinkRow through Expo Link on %s", (os) => {
  beforeEach(() => {
    platform = os;
  });

  test.each([false, true])("keeps its row layout and press feedback (isLast=%s)", (isLast) => {
    for (const nextPressed of [false, true, false]) {
      pressed = nextPressed;
      renderRow(isLast);
      const rowStyle = nativeStyles.find((style) => style.flexDirection === "row");
      expect(rowStyle).toMatchObject({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        minHeight: 48,
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: isLast ? 0 : 0.5,
        backgroundColor: pressed ? theme.surfaceMuted : theme.surface,
      });
    }
  });

  test("preserves the link destination and accessible row label", () => {
    const markup = renderRow();
    expect(markup).toContain("Remote access");
    expect(markup).toContain("Pair and reconnect.");
    expect(pressableProps).toMatchObject({
      accessibilityRole: "link",
      accessibilityLabel: "Remote access, Connected, Pair and reconnect.",
      accessibilityHint: "Opens a screen",
    });
    expect(pressableProps?.onPress).toBeFunction();
    pressableProps!.onPress!({});
    expect(navigations).toEqual(["/pairing"]);
  });
});
