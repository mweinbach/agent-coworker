/**
 * Isolated component harness for the mobile hub headers/toolbars. Spawned by
 * test/mobile.header-glass-button.test.ts in a Bun subprocess so the
 * mock.module calls for react-native/expo-router never leak into the shared
 * test process.
 */
import { describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "../../apps/desktop/test/jsdomHarness";

type HostProps = Record<string, unknown> & { children?: ReactNode };
const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));

function mockMobileModule(alias: string, factory: () => unknown): void {
  mock.module(alias, factory);
  mock.module(mobileRequire.resolve(alias), factory);
}

function mockLocalModule(alias: string, relativePath: string, factory: () => unknown): void {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(`${resolved}.ts`, factory);
  mock.module(`${resolved}.tsx`, factory);
}

const hostComponent =
  (tag: string) =>
  ({ children, ...props }: HostProps) => {
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "style" || typeof value === "function") continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        attributes[`data-${key.toLowerCase()}`] = String(value);
      }
    }
    return createElement(tag, attributes, children);
  };

const NativeView = hostComponent("div");
const NativeText = ({ children, ...props }: HostProps) =>
  createElement(
    "span",
    {
      "data-accessibility-role":
        typeof props.accessibilityRole === "string" ? props.accessibilityRole : undefined,
    },
    children,
  );
const NativePressable = ({
  accessibilityLabel,
  accessibilityRole,
  children,
  disabled,
  onPress,
  style,
  ...props
}: HostProps) =>
  createElement(
    "button",
    {
      "aria-label": typeof accessibilityLabel === "string" ? accessibilityLabel : undefined,
      "data-accessibility-role":
        typeof accessibilityRole === "string" ? accessibilityRole : undefined,
      "data-testid": typeof props.testID === "string" ? props.testID : undefined,
      disabled: disabled === true,
      onClick: onPress as (() => void) | undefined,
      type: "button",
    },
    children,
  );

const reactNativeMockFactory = () => ({
  AccessibilityInfo: {
    addEventListener: () => ({ remove: () => undefined }),
    announceForAccessibilityWithOptions: () => undefined,
    isReduceMotionEnabled: async () => false,
    setAccessibilityFocus: () => undefined,
  },
  Alert: { alert: () => undefined },
  LayoutAnimation: {
    configureNext: () => undefined,
    Presets: { easeInEaseOut: {} },
  },
  Linking: {
    canOpenURL: async () => true,
    openURL: async () => undefined,
  },
  Platform: { OS: "ios", select: (specifics: { ios?: unknown }) => specifics.ios },
  Pressable: NativePressable,
  ScrollView: ({ children, contentInsetAdjustmentBehavior, ...props }: HostProps) =>
    createElement(
      "div",
      {
        "data-scroll-view": "true",
        "data-content-inset-adjustment":
          typeof contentInsetAdjustmentBehavior === "string"
            ? contentInsetAdjustmentBehavior
            : undefined,
        ...(typeof props.testID === "string" ? { "data-testid": props.testID } : {}),
      },
      children,
    ),
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles,
    flatten: (style: unknown) => style,
    hairlineWidth: 1,
  },
  Switch: ({ value, onValueChange }: HostProps) =>
    createElement("input", {
      checked: value === true,
      onChange: () => (onValueChange as ((next: boolean) => void) | undefined)?.(value !== true),
      type: "checkbox",
    }),
  Text: NativeText,
  View: NativeView,
  findNodeHandle: () => 1,
});
mockMobileModule("react-native", reactNativeMockFactory);
mock.module(path.resolve("apps/mobile/node_modules/react-native"), reactNativeMockFactory);

const swipeableMockFactory = () => ({
  default: NativeView,
});
mockMobileModule("react-native-gesture-handler/Swipeable", swipeableMockFactory);

type CapturedScreen = {
  kind: "screen" | "stack";
  name?: string;
  options?: Record<string, unknown>;
};
const capturedScreens: CapturedScreen[] = [];

const Stack = Object.assign(
  ({ children, screenOptions }: HostProps) => {
    capturedScreens.push({
      kind: "stack",
      options:
        typeof screenOptions === "object" && screenOptions !== null
          ? (screenOptions as Record<string, unknown>)
          : undefined,
    });
    return createElement("div", { "data-stack": "true" }, children);
  },
  {
    Screen: ({ name, options }: HostProps) => {
      capturedScreens.push({
        kind: "screen",
        name: typeof name === "string" ? name : undefined,
        options:
          typeof options === "object" && options !== null
            ? (options as Record<string, unknown>)
            : undefined,
      });
      return null;
    },
  },
);

mockMobileModule("expo-router", () => ({
  Link: ({ children, href }: HostProps) =>
    createElement("a", { "data-href": String(href) }, children),
  Stack,
  useRouter: () => ({ back: () => undefined, replace: () => undefined }),
}));
mockMobileModule("expo-router/stack", () => ({ Stack }));

mockLocalModule("@/components/ui/sf-symbol", "apps/mobile/src/components/ui/sf-symbol", () => ({
  SFSymbol: ({ name }: { name: string }) =>
    createElement("span", { "aria-hidden": "true", "data-system-name": name }),
}));

const theme = {
  background: "#ffffff",
  backgroundMuted: "#f6f7f0",
  border: "#ced2bd",
  borderMuted: "#e3e6d8",
  danger: "#b42318",
  isDark: false,
  primary: "#526600",
  primaryMuted: "#e6edc4",
  primaryText: "#ffffff",
  surface: "#ffffff",
  surfaceMuted: "#f0f2e8",
  text: "#1d2115",
  textSecondary: "#4d5440",
  textTertiary: "#707762",
};
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => theme,
}));

// The workspace switcher modal pulls in the live JSON-RPC session stack; it is
// out of scope for the hub grouped-list/header contract under test here.
mockLocalModule(
  "@/components/workspace/workspace-switcher",
  "apps/mobile/src/components/workspace/workspace-switcher",
  () => ({
    WorkspaceSwitcher: () => null,
  }),
);

// Imports must follow the module mocks so each route renders host primitives.
const { default: WorkspaceHubScreen } = await import(
  "../../apps/mobile/src/app/(app)/(tabs)/(workspace)/workspace/index"
);
const { default: SettingsHubScreen } = await import(
  "../../apps/mobile/src/app/(app)/(tabs)/(settings)/settings/index"
);
const { default: WorkspaceStackLayout } = await import(
  "../../apps/mobile/src/app/(app)/(tabs)/(workspace)/_layout"
);
const { default: SettingsStackLayout } = await import(
  "../../apps/mobile/src/app/(app)/(tabs)/(settings)/_layout"
);
const { default: PairingLayout } = await import("../../apps/mobile/src/app/(pairing)/_layout");

async function renderScreen(
  element: ReturnType<typeof createElement>,
  run: (body: HTMLElement) => void | Promise<void>,
) {
  const harness = setupJsdom({ includeAnimationFrame: true });
  const container = harness.dom.window.document.getElementById("root");
  if (!container) throw new Error("missing root container");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(element);
    });
    await run(harness.dom.window.document.body);
  } finally {
    await act(async () => {
      root.unmount();
    });
    harness.restore();
  }
}

describe("mobile native header toolbar", () => {
  test("workspace hub renders a grouped native list", async () => {
    await renderScreen(createElement(WorkspaceHubScreen), (body) => {
      // The hub body is one native grouped scroll surface, not ad hoc chrome.
      const scroller = body.querySelector('[data-scroll-view="true"]');
      expect(scroller).not.toBeNull();
      expect(scroller?.getAttribute("data-content-inset-adjustment")).toBe("automatic");

      const text = body.textContent ?? "";
      for (const sectionTitle of [
        "Current workspace",
        "Model availability",
        "Workspace editors",
        "Related controls",
      ]) {
        expect(text).toContain(sectionTitle);
      }
      expect(text).toContain("Connection");
      expect(text).toContain("Switch workspace");

      const hrefs = Array.from(body.querySelectorAll("a[data-href]")).map((link) =>
        link.getAttribute("data-href"),
      );
      expect(hrefs).toContain("/workspace/general");
      expect(hrefs).toContain("/workspace/memory");
      expect(hrefs).toContain("/workspace/backups");
      expect(hrefs).toContain("/settings/usage");
    });
  });

  test("settings hub renders a grouped native list", async () => {
    await renderScreen(createElement(SettingsHubScreen), (body) => {
      const scroller = body.querySelector('[data-scroll-view="true"]');
      expect(scroller).not.toBeNull();
      expect(scroller?.getAttribute("data-content-inset-adjustment")).toBe("automatic");

      const text = body.textContent ?? "";
      for (const sectionTitle of [
        "Connection",
        "Workspace controls",
        "Display",
        "Workspace editors",
      ]) {
        expect(text).toContain(sectionTitle);
      }
      expect(text).toContain("Show debug messages");
      expect(body.querySelector('input[type="checkbox"]')).not.toBeNull();

      const hrefs = Array.from(body.querySelectorAll("a[data-href]")).map((link) =>
        link.getAttribute("data-href"),
      );
      expect(hrefs).toContain("/settings/providers");
      expect(hrefs).toContain("/settings/mcp");
      expect(hrefs).toContain("/settings/usage");
    });
  });

  test("hub stacks omit prominent header items and pairing empties them", async () => {
    capturedScreens.length = 0;
    await renderScreen(createElement(WorkspaceStackLayout), () => {});
    await renderScreen(createElement(SettingsStackLayout), () => {});
    const hubEntries = [...capturedScreens];
    capturedScreens.length = 0;
    await renderScreen(createElement(PairingLayout), () => {});
    const pairingEntries = [...capturedScreens];

    // Neither hub stack configures native-stack right header items, so the
    // green prominent chrome cannot appear on the workspace/settings hubs.
    expect(hubEntries.length).toBeGreaterThan(0);
    for (const entry of hubEntries) {
      expect(entry.options && "unstable_headerRightItems" in entry.options).toBeFalsy();
      expect(entry.options && "headerRight" in entry.options).toBeFalsy();
    }

    // The pairing index screen actively clears the right header items instead
    // of leaving the platform default.
    const pairingIndex = pairingEntries.find(
      (entry) => entry.kind === "screen" && entry.name === "index",
    );
    if (!pairingIndex?.options) throw new Error("missing pairing index screen options");
    const headerRight = pairingIndex.options.headerRight;
    expect(typeof headerRight).toBe("function");
    expect((headerRight as () => unknown)()).toBeNull();
    const headerRightItems = pairingIndex.options.unstable_headerRightItems;
    expect(typeof headerRightItems).toBe("function");
    expect((headerRightItems as () => unknown[])()).toEqual([]);

    // No captured screen anywhere marks a header item prominent.
    for (const entry of [...hubEntries, ...pairingEntries]) {
      const items =
        typeof entry.options?.unstable_headerRightItems === "function"
          ? (entry.options.unstable_headerRightItems as () => unknown[])()
          : [];
      for (const item of items) {
        expect(
          typeof item === "object" && item !== null
            ? (item as { variant?: string }).variant
            : undefined,
        ).not.toBe("prominent");
      }
    }
  });
});
