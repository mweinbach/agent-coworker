import { describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import { act, type ComponentType, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "../../apps/desktop/test/jsdomHarness";

type ComposerProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  canEdit: boolean;
  canSubmit: boolean;
  isSubmitting: boolean;
  isBusy: boolean;
  isStopping: boolean;
};
const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));

function mockMobileModule(alias: string, factory: () => unknown): void {
  mock.module(alias, factory);
  mock.module(mobileRequire.resolve(alias), factory);
}

function mockLocalModule(alias: string, relativePath: string, factory: () => unknown) {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(`${resolved}.ts`, factory);
  mock.module(`${resolved}.tsx`, factory);
}

const nativeContainer = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as React.ReactNode);

const reactNativeMockFactory = () => ({
  AccessibilityInfo: {
    addEventListener: () => ({ remove: () => undefined }),
    announceForAccessibilityWithOptions: () => undefined,
    isReduceMotionEnabled: async () => false,
    setAccessibilityFocus: () => undefined,
  },
  LayoutAnimation: {
    configureNext: () => undefined,
    Presets: { easeInEaseOut: {} },
  },
  Platform: { OS: "android" },
  View: nativeContainer,
  findNodeHandle: () => null,
  Text: ({ children, ...props }: Record<string, unknown>) =>
    createElement("span", props, children as React.ReactNode),
  TextInput: ({
    editable,
    onChangeText: _onChangeText,
    onContentSizeChange: _onContentSizeChange,
    ...props
  }: Record<string, unknown>) =>
    createElement("textarea", {
      ...props,
      "data-editable": String(editable),
    }),
  Pressable: ({
    accessibilityLabel,
    accessibilityRole: _accessibilityRole,
    accessibilityState,
    children,
    disabled,
    hitSlop: _hitSlop,
    onPress,
    style,
    ...props
  }: Record<string, unknown>) =>
    createElement(
      "button",
      {
        ...props,
        "aria-label": accessibilityLabel,
        "aria-busy":
          typeof accessibilityState === "object" &&
          accessibilityState !== null &&
          "busy" in accessibilityState
            ? String(accessibilityState.busy)
            : undefined,
        disabled,
        onClick: onPress as (() => void) | undefined,
        style:
          typeof style === "function"
            ? style({ pressed: false })
            : (style as React.CSSProperties | undefined),
      },
      children as React.ReactNode,
    ),
});
mockMobileModule("react-native", reactNativeMockFactory);
mock.module(path.resolve("apps/mobile/node_modules/react-native"), reactNativeMockFactory);

type Modifier = {
  kind: string;
  value: unknown;
};

const modifier = (kind: string) => (value: unknown) => ({ kind, value });
const swiftContainer = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as React.ReactNode);
mockMobileModule("@expo/ui/swift-ui", () => ({
  Button: ({ onPress }: { onPress?: () => void }) => createElement("button", { onClick: onPress }),
  Group: swiftContainer,
  Host: swiftContainer,
  HStack: swiftContainer,
  RNHostView: swiftContainer,
  Image: ({
    color: _color,
    modifiers,
    onPress,
    size: _size,
    systemName,
  }: {
    color?: string;
    modifiers?: Modifier[];
    onPress?: () => void;
    size?: number;
    systemName: string;
  }) => {
    const disabled = modifiers?.find((entry) => entry.kind === "disabled")?.value === true;
    const label = modifiers?.find((entry) => entry.kind === "accessibilityLabel")?.value;
    return createElement("button", {
      "aria-label": typeof label === "string" ? label : undefined,
      "data-system-name": systemName,
      disabled,
      onClick: onPress,
    });
  },
}));
mockMobileModule("@expo/ui/swift-ui/modifiers", () => ({
  accessibilityAddTraits: modifier("accessibilityAddTraits"),
  accessibilityLabel: modifier("accessibilityLabel"),
  background: (value: unknown, shape: unknown) => ({ kind: "background", value, shape }),
  buttonStyle: modifier("buttonStyle"),
  controlSize: modifier("controlSize"),
  disabled: modifier("disabled"),
  foregroundStyle: modifier("foregroundStyle"),
  frame: modifier("frame"),
  glassEffect: modifier("glassEffect"),
  padding: modifier("padding"),
  shapes: {
    circle: () => "circle",
  },
  tint: modifier("tint"),
}));
mockMobileModule("expo-glass-effect", () => ({
  GlassView: nativeContainer,
  isLiquidGlassAvailable: () => false,
}));
mockLocalModule("@/components/ui/sf-symbol", "apps/mobile/src/components/ui/sf-symbol", () => ({
  SFSymbol: ({ name }: { name: string }) => createElement("span", { "data-system-name": name }),
}));
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    danger: "#c00",
    isDark: false,
    primary: "#060",
    primaryText: "#fff",
    surface: "#fff",
    surfaceMuted: "#ddd",
    text: "#111",
    textTertiary: "#666",
  }),
}));

// Imports must follow module mocks so each platform file renders through deterministic host primitives.
const { ComposerBar: AndroidComposerBar } = await import(
  "../../apps/mobile/src/components/ComposerBar.tsx"
);
const { ComposerBar: IosComposerBar } = await import(
  "../../apps/mobile/src/components/ComposerBar.ios.tsx"
);

const platformComponents = [
  ["android", AndroidComposerBar],
  ["ios", IosComposerBar],
] as const satisfies ReadonlyArray<readonly [string, ComponentType<ComposerProps>]>;

describe("mobile composer platform components", () => {
  test.each(platformComponents)(
    "%s renders editable first-character policy and a locked Stop action",
    async (_platform, ComposerBar) => {
      const harness = setupJsdom();
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root container");
      const root = createRoot(container);
      let submitCount = 0;
      let stopCount = 0;
      const baseProps: ComposerProps = {
        value: "",
        onChangeText: () => undefined,
        onSubmit: () => {
          submitCount += 1;
        },
        onStop: () => {
          stopCount += 1;
        },
        canEdit: true,
        canSubmit: false,
        isSubmitting: false,
        isBusy: false,
        isStopping: false,
      };

      try {
        await act(async () => {
          root.render(createElement(ComposerBar, baseProps));
        });
        expect(container.querySelector("textarea")?.getAttribute("data-editable")).toBe("true");
        expect(container.querySelector("button")?.hasAttribute("disabled")).toBe(true);

        await act(async () => {
          root.render(
            createElement(ComposerBar, {
              ...baseProps,
              value: "h",
              canSubmit: true,
            }),
          );
        });
        const send = container.querySelector('button[aria-label="Send"]');
        expect(send?.hasAttribute("disabled")).toBe(false);
        send?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        expect(submitCount).toBe(1);

        await act(async () => {
          root.render(
            createElement(ComposerBar, {
              ...baseProps,
              isBusy: true,
            }),
          );
        });
        const stop = container.querySelector('button[aria-label="Stop turn"]');
        expect(stop?.hasAttribute("disabled")).toBe(false);
        stop?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        expect(stopCount).toBe(1);

        await act(async () => {
          root.render(
            createElement(ComposerBar, {
              ...baseProps,
              isBusy: true,
              isStopping: true,
            }),
          );
        });
        expect(
          container.querySelector('button[aria-label="Stopping turn"]')?.hasAttribute("disabled"),
        ).toBe(true);
      } finally {
        await act(async () => {
          root.unmount();
        });
        harness.restore();
      }
    },
  );
});
