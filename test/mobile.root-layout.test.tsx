import { afterAll, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));
let colorScheme: "light" | "dark" = "light";
let fontsLoaded = true;

function mockMobileModule(alias: string, factory: () => unknown) {
  mock.module(alias, factory);
  mock.module(mobileRequire.resolve(alias), factory);
}

function mockLocalModule(alias: string, relativePath: string, factory: () => unknown) {
  mock.module(alias, factory);
  mock.module(path.resolve(relativePath), factory);
}

function Container({ children }: { children?: ReactNode }) {
  return createElement("div", null, children);
}

mockMobileModule("react-native", () => ({
  useColorScheme: () => colorScheme,
  View: Container,
  StatusBar: ({ barStyle }: { barStyle: string }) =>
    createElement("span", { "data-status-bar-style": barStyle }),
}));
mockMobileModule("react-native-safe-area-context", () => ({ SafeAreaProvider: Container }));
mockMobileModule("expo-font", () => ({ useFonts: () => [fontsLoaded] }));
mockMobileModule("expo-router", () => ({
  Stack: Object.assign(Container, { Screen: () => null }),
}));
mockMobileModule("expo-router/react-navigation", () => ({
  DarkTheme: { colors: {} },
  DefaultTheme: { colors: {} },
  ThemeProvider: Container,
}));
mockLocalModule(
  "@/providers/MobileAppProvider",
  "apps/mobile/src/providers/MobileAppProvider.tsx",
  () => ({ MobileAppProvider: Container }),
);
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme.ts", () => ({
  resolveColorScheme: (scheme: string) => scheme,
  useAppTheme: () => ({
    isDark: colorScheme === "dark",
    background: colorScheme === "dark" ? "#111" : "#eee",
  }),
}));

for (const font of [
  "IBMPlexSans-Variable.ttf",
  "IBMPlexSans-Italic-Variable.ttf",
  "IBMPlexMono-Regular.ttf",
  "IBMPlexMono-Medium.ttf",
  "IBMPlexMono-SemiBold.ttf",
  "IBMPlexMono-Bold.ttf",
]) {
  mock.module(path.resolve("apps/mobile/assets/fonts", font), () => ({ default: 1 }));
}

const { default: RootLayout } = await import("../apps/mobile/src/app/_layout");

afterAll(() => mock.restore());

describe("mobile status bar contrast", () => {
  test.each([
    ["light", "dark-content", false],
    ["light", "dark-content", true],
    ["dark", "light-content", false],
    ["dark", "light-content", true],
  ] as const)("uses %s colors with %s icons when fonts loaded=%s", (scheme, style, loaded) => {
    colorScheme = scheme;
    fontsLoaded = loaded;

    const html = renderToStaticMarkup(createElement(RootLayout));

    expect(html).toContain(`data-status-bar-style="${style}"`);
    expect(html.match(/data-status-bar-style=/g)).toHaveLength(1);
  });
});
