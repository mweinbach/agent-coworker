import { describe, expect, mock, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { act, createElement, forwardRef, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "../../apps/desktop/test/jsdomHarness";
import {
  MOBILE_DEEP_LINKS,
  MOBILE_TABS,
} from "../../apps/mobile/src/features/navigation/mobile-navigation";

type Platform = "ios" | "android";
type AccessibilityState = {
  busy?: boolean;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
};
type HostProps = Record<string, unknown> & {
  children?: ReactNode;
};
type Modifier = {
  kind: string;
  value?: unknown;
};
type SnapshotControl = {
  role: string;
  label: string;
  hint?: string;
  live?: string;
  minHeight?: number;
  state?: AccessibilityState;
};
const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));

function mockMobileModule(alias: string, factory: () => unknown): void {
  mock.module(alias, factory);
  mock.module(mobileRequire.resolve(alias), factory);
}

const platformValue = process.env.EXPO_OS;
if (platformValue !== "ios" && platformValue !== "android") {
  throw new Error("EXPO_OS must be ios or android for the mobile platform contract");
}
const platform: Platform = platformValue;
const minimumTarget = platform === "ios" ? 44 : 48;
const fontScale = 2;
const announcements: string[] = [];
let reducedMotionEnabled = false;
let layoutAnimationCount = 0;

function mockLocalModule(alias: string, relativePath: string, factory: () => unknown): void {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(`${resolved}.ts`, factory);
  mock.module(`${resolved}.tsx`, factory);
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    const flattened: Record<string, unknown> = {};
    for (const entry of style) {
      Object.assign(flattened, flattenStyle(entry));
    }
    return flattened;
  }
  if (typeof style === "object" && style !== null) {
    return style as Record<string, unknown>;
  }
  return {};
}

function numericStyle(style: Record<string, unknown>, key: string): number | undefined {
  const value = style[key];
  return typeof value === "number" ? value : undefined;
}

function accessibilityAttributes(
  role: unknown,
  label: unknown,
  hint: unknown,
  state: unknown,
  liveRegion: unknown,
): Record<string, unknown> {
  const accessibilityState =
    typeof state === "object" && state !== null ? (state as AccessibilityState) : {};
  return {
    "aria-busy": accessibilityState.busy,
    "aria-checked": accessibilityState.checked,
    "aria-disabled": accessibilityState.disabled,
    "aria-expanded": accessibilityState.expanded,
    "aria-label": typeof label === "string" ? label : undefined,
    "aria-selected": accessibilityState.selected,
    "data-accessibility-hint": typeof hint === "string" ? hint : undefined,
    "data-accessibility-live": typeof liveRegion === "string" ? liveRegion : undefined,
    "data-accessibility-role": typeof role === "string" ? role : undefined,
    "data-a11y-node":
      typeof role === "string" || typeof label === "string" || typeof liveRegion === "string"
        ? "true"
        : undefined,
  };
}

const NativeView = forwardRef<HTMLElement, HostProps>(function NativeView(
  {
    accessibilityHint,
    accessibilityLabel,
    accessibilityLiveRegion,
    accessibilityRole,
    accessibilityState,
    children,
    style,
  },
  ref,
) {
  const flattenedStyle = flattenStyle(style);
  return createElement(
    "div",
    {
      ...accessibilityAttributes(
        accessibilityRole ??
          (typeof accessibilityLabel === "string" || typeof accessibilityLiveRegion === "string"
            ? "group"
            : undefined),
        accessibilityLabel,
        accessibilityHint,
        accessibilityState,
        accessibilityLiveRegion,
      ),
      "data-min-height": numericStyle(flattenedStyle, "minHeight"),
      ref,
    },
    children,
  );
});

function NativeText({
  accessibilityLabel,
  accessibilityRole,
  children,
  maxFontSizeMultiplier,
  numberOfLines,
  style,
}: HostProps) {
  const flattenedStyle = flattenStyle(style);
  const maximumScale =
    typeof maxFontSizeMultiplier === "number" ? maxFontSizeMultiplier : fontScale;
  const effectiveScale = Math.min(fontScale, maximumScale);
  const fontSize = numericStyle(flattenedStyle, "fontSize") ?? 14;
  return createElement(
    "span",
    {
      ...accessibilityAttributes(
        accessibilityRole,
        accessibilityLabel,
        undefined,
        undefined,
        undefined,
      ),
      "data-effective-font-scale": effectiveScale,
      "data-font-size": fontSize,
      "data-number-of-lines": typeof numberOfLines === "number" ? numberOfLines : undefined,
      "data-scaled-font-size": fontSize * effectiveScale,
    },
    children,
  );
}

function NativeTextInput({
  accessibilityHint,
  accessibilityLabel,
  accessibilityState,
  editable,
  maxFontSizeMultiplier,
  placeholder,
  style,
  value,
}: HostProps) {
  const flattenedStyle = flattenStyle(style);
  const maximumScale =
    typeof maxFontSizeMultiplier === "number" ? maxFontSizeMultiplier : fontScale;
  const effectiveScale = Math.min(fontScale, maximumScale);
  const fontSize = numericStyle(flattenedStyle, "fontSize") ?? 14;
  return createElement("textarea", {
    ...accessibilityAttributes(
      "textbox",
      accessibilityLabel,
      accessibilityHint,
      accessibilityState,
      undefined,
    ),
    "data-effective-font-scale": effectiveScale,
    "data-font-size": fontSize,
    "data-min-height": numericStyle(flattenedStyle, "minHeight"),
    "data-scaled-font-size": fontSize * effectiveScale,
    disabled: editable === false,
    placeholder: typeof placeholder === "string" ? placeholder : undefined,
    readOnly: true,
    value: typeof value === "string" ? value : "",
  });
}

function NativePressable({
  accessibilityHint,
  accessibilityLabel,
  accessibilityLiveRegion,
  accessibilityRole,
  accessibilityState,
  children,
  disabled,
  onPress,
  style,
}: HostProps) {
  const styleResolver =
    typeof style === "function" ? (style as (state: { pressed: boolean }) => unknown) : null;
  const restStyle = flattenStyle(styleResolver ? styleResolver({ pressed: false }) : style);
  const pressedStyle = flattenStyle(styleResolver ? styleResolver({ pressed: true }) : style);
  const isInteractive = typeof onPress === "function" || typeof accessibilityRole === "string";
  const tag = isInteractive ? "button" : "div";
  const resolvedChildren =
    typeof children === "function"
      ? (children as (state: { pressed: boolean }) => ReactNode)({ pressed: false })
      : children;
  return createElement(
    tag,
    {
      ...accessibilityAttributes(
        accessibilityRole ?? (isInteractive ? "button" : undefined),
        accessibilityLabel,
        accessibilityHint,
        accessibilityState,
        accessibilityLiveRegion,
      ),
      "data-min-height": numericStyle(restStyle, "minHeight") ?? numericStyle(restStyle, "height"),
      "data-pressed-transform":
        pressedStyle.transform === undefined ? undefined : JSON.stringify(pressedStyle.transform),
      disabled: disabled === true,
      onClick: disabled === true ? undefined : (onPress as (() => void) | undefined),
      type: tag === "button" ? "button" : undefined,
    },
    resolvedChildren,
  );
}

function NativeSwitch({
  accessibilityElementsHidden,
  accessible,
  accessibilityLabel,
  accessibilityState,
  value,
}: HostProps) {
  if (accessible === false || accessibilityElementsHidden === true) {
    return createElement("span", {
      "aria-hidden": "true",
      "data-decorative-switch": String(value === true),
    });
  }
  return createElement("input", {
    ...accessibilityAttributes(
      "switch",
      accessibilityLabel,
      undefined,
      accessibilityState,
      undefined,
    ),
    checked: value === true,
    readOnly: true,
    type: "checkbox",
  });
}

const reactNativeMockFactory = () => ({
  AccessibilityInfo: {
    addEventListener: () => ({ remove: () => undefined }),
    announceForAccessibilityWithOptions: (message: string) => {
      announcements.push(message);
    },
    isReduceMotionEnabled: async () => reducedMotionEnabled,
    setAccessibilityFocus: () => undefined,
  },
  Alert: { alert: () => undefined },
  LayoutAnimation: {
    configureNext: () => {
      layoutAnimationCount += 1;
    },
    Presets: { easeInEaseOut: {} },
  },
  Linking: {
    canOpenURL: async () => true,
    openURL: async () => undefined,
  },
  Platform: { OS: platform },
  Pressable: NativePressable,
  ScrollView: NativeView,
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T) => styles,
    flatten: flattenStyle,
    hairlineWidth: 1,
  },
  Switch: NativeSwitch,
  Text: NativeText,
  TextInput: NativeTextInput,
  View: NativeView,
  findNodeHandle: () => 1,
});
mockMobileModule("react-native", reactNativeMockFactory);
mock.module(path.resolve("apps/mobile/node_modules/react-native"), reactNativeMockFactory);

const modifier = (kind: string) => (value?: unknown) => ({ kind, value });
const modifierValue = (modifiers: unknown, kind: string): unknown => {
  if (!Array.isArray(modifiers)) {
    return undefined;
  }
  return (modifiers as Modifier[]).find((entry) => entry.kind === kind)?.value;
};
const SwiftContainer = ({ children }: HostProps) => createElement("div", null, children);

mockMobileModule("@expo/ui/swift-ui", () => ({
  Button: ({ children, modifiers, onPress }: HostProps) => {
    const disabled = modifierValue(modifiers, "disabled") === true;
    const frame = flattenStyle(modifierValue(modifiers, "frame"));
    return createElement(
      "button",
      {
        ...accessibilityAttributes("button", undefined, undefined, { disabled }, undefined),
        "data-min-height": numericStyle(frame, "height") ?? minimumTarget,
        disabled,
        onClick: disabled ? undefined : (onPress as (() => void) | undefined),
        type: "button",
      },
      children,
    );
  },
  ContentUnavailableView: ({ description, title }: HostProps) =>
    createElement("div", null, `${String(title)}. ${String(description)}`),
  Group: SwiftContainer,
  Host: SwiftContainer,
  HStack: SwiftContainer,
  Image: ({ modifiers, onPress, systemName }: HostProps) => {
    const disabled = modifierValue(modifiers, "disabled") === true;
    const frame = flattenStyle(modifierValue(modifiers, "frame"));
    const label = modifierValue(modifiers, "accessibilityLabel");
    return createElement("button", {
      ...accessibilityAttributes("button", label, undefined, { disabled }, undefined),
      "data-min-height": numericStyle(frame, "height") ?? minimumTarget,
      "data-system-name": systemName,
      disabled,
      onClick: disabled ? undefined : (onPress as (() => void) | undefined),
      type: "button",
    });
  },
  Label: ({ title }: HostProps) =>
    createElement("span", { "data-effective-font-scale": fontScale }, String(title)),
  List: SwiftContainer,
  ProgressView: () =>
    createElement("div", {
      ...accessibilityAttributes("progressbar", "Connecting", undefined, { busy: true }, "polite"),
    }),
  RNHostView: SwiftContainer,
  Section: ({ children, footer, title }: HostProps) =>
    createElement(
      "section",
      null,
      typeof title === "string"
        ? createElement("h2", { "data-effective-font-scale": fontScale }, title)
        : null,
      children,
      footer,
    ),
  Text: ({ children }: HostProps) =>
    createElement("span", { "data-effective-font-scale": fontScale }, children),
}));

mockMobileModule("@expo/ui/swift-ui/modifiers", () => ({
  accessibilityAddTraits: modifier("accessibilityAddTraits"),
  accessibilityLabel: modifier("accessibilityLabel"),
  background: (value: unknown, shape: unknown) => ({ kind: "background", shape, value }),
  buttonStyle: modifier("buttonStyle"),
  controlSize: modifier("controlSize"),
  disabled: modifier("disabled"),
  foregroundStyle: modifier("foregroundStyle"),
  frame: modifier("frame"),
  glassEffect: modifier("glassEffect"),
  labelStyle: modifier("labelStyle"),
  listStyle: modifier("listStyle"),
  padding: modifier("padding"),
  shapes: { circle: () => "circle" },
  tint: modifier("tint"),
}));

mockMobileModule("expo-camera", () => ({
  CameraView: ({ accessibilityLabel }: HostProps) =>
    createElement("div", {
      ...accessibilityAttributes("image", accessibilityLabel, undefined, undefined, undefined),
    }),
  useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
}));

mockMobileModule("expo-glass-effect", () => ({
  GlassView: NativeView,
  isLiquidGlassAvailable: () => false,
}));

mockMobileModule("expo-image", () => ({
  Image: ({ accessible, accessibilityLabel }: HostProps) =>
    createElement("img", {
      alt: accessible === false ? "" : String(accessibilityLabel ?? ""),
      "aria-hidden": accessible === false ? "true" : undefined,
    }),
}));

const swipeableMockFactory = () => ({
  default: SwiftContainer,
});
mockMobileModule("react-native-gesture-handler/Swipeable", swipeableMockFactory);

const NativeTabsTrigger = Object.assign(
  ({ children, name }: HostProps) =>
    createElement("div", { "data-tab-route": String(name) }, children),
  {
    Badge: ({ children, hidden }: HostProps) =>
      createElement("span", { "data-tab-badge": hidden === true ? "hidden" : "visible" }, children),
    Icon: ({ md, sf }: HostProps) =>
      createElement("span", {
        "data-tab-icon-md": JSON.stringify(md),
        "data-tab-icon-sf": JSON.stringify(sf),
      }),
    Label: ({ children }: HostProps) => createElement("span", { "data-tab-label": true }, children),
  },
);

const NativeTabs = Object.assign(
  ({ backBehavior, children }: HostProps) =>
    createElement("nav", { "data-native-tabs-back-behavior": backBehavior }, children),
  { Trigger: NativeTabsTrigger },
);

mockMobileModule("expo-router/unstable-native-tabs", () => ({ NativeTabs }));

const Stack = Object.assign(
  ({ children }: HostProps) => createElement("div", { "data-stack": true }, children),
  {
    Screen: ({ name, options }: HostProps) => {
      const optionRecord =
        typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
      const HeaderLeft =
        typeof optionRecord.headerLeft === "function"
          ? (optionRecord.headerLeft as () => ReactNode)
          : null;
      return createElement(
        "span",
        {
          "data-stack-screen": typeof name === "string" ? name : "",
          "data-stack-title": typeof optionRecord.title === "string" ? optionRecord.title : "",
        },
        HeaderLeft ? createElement(HeaderLeft) : null,
      );
    },
    Toolbar: Object.assign(SwiftContainer, { Button: () => null }),
  },
);

const routerMock = {
  back: () => undefined,
  replace: () => undefined,
};
mockMobileModule("expo-router", () => ({
  Stack,
  useRouter: () => routerMock,
}));
mockMobileModule("expo-router/stack", () => ({ Stack }));

mockLocalModule("@/components/ui/sf-symbol", "apps/mobile/src/components/ui/sf-symbol", () => ({
  SFSymbol: ({ name }: { name: string }) =>
    createElement("span", { "aria-hidden": "true", "data-system-name": name }),
}));

const theme = {
  accent: "#4f6200",
  accentMuted: "#eef2d8",
  background: "#ffffff",
  backgroundMuted: "#f6f7f0",
  border: "#ced2bd",
  borderMuted: "#e3e6d8",
  danger: "#b42318",
  dangerMuted: "#fee4e2",
  fontFamilyMono: "monospace",
  isDark: false,
  primary: "#526600",
  primaryMuted: "#e6edc4",
  primaryText: "#ffffff",
  shadow: "none",
  surface: "#ffffff",
  surfaceElevated: "#ffffff",
  surfaceMuted: "#f0f2e8",
  text: "#1d2115",
  textSecondary: "#4d5440",
  textTertiary: "#707762",
  warning: "#9a6700",
  warningMuted: "#fff3c4",
};
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => theme,
}));

mockLocalModule(
  "@/features/cowork/threadStore",
  "apps/mobile/src/features/cowork/threadStore",
  () => ({
    useThreadStore: (selector: (state: { pendingRequests: Record<string, object> }) => unknown) =>
      selector({ pendingRequests: { approval: {}, question: {} } }),
  }),
);

mockLocalModule(
  "@/features/pairing/pairingStore",
  "apps/mobile/src/features/pairing/pairingStore",
  () => ({
    usePairingStore: (
      selector: (state: {
        connectionState: { status: "idle"; lastError: null };
        connectWithQr: () => Promise<void>;
      }) => unknown,
    ) =>
      selector({
        connectionState: { status: "idle", lastError: null },
        connectWithQr: async () => undefined,
      }),
  }),
);

// Imports follow mocks because the fixture intentionally renders native modules through host shims.
const { AppButton } = await import("../../apps/mobile/src/components/ui/app-button");
const { GroupedSwitchRow } = await import("../../apps/mobile/src/components/pairing/grouped-list");
const { PendingRequestCard } = await import(
  "../../apps/mobile/src/components/thread/pending-request-card"
);
const { ReasoningCard } = await import("../../apps/mobile/src/components/thread/reasoning-card");
const { SourcesCarousel } = await import(
  "../../apps/mobile/src/components/thread/sources-carousel"
);
const { ToolCallCard } = await import("../../apps/mobile/src/components/thread/tool-call-card");
const { runAccessibleLayoutAnimation } = await import(
  "../../apps/mobile/src/features/accessibility/mobile-accessibility"
);
const { default: AppTabsLayout, unstable_settings: tabSettings } = await import(
  "../../apps/mobile/src/app/(app)/(tabs)/_layout"
);
const { default: ChatsStackLayout, unstable_settings: chatsSettings } = await import(
  "../../apps/mobile/src/app/(app)/(tabs)/(chats)/_layout"
);
const { default: WorkspaceStackLayout, unstable_settings: workspaceSettings } = await import(
  "../../apps/mobile/src/app/(app)/(tabs)/(workspace)/_layout"
);
const { default: SkillsStackLayout, unstable_settings: skillsSettings } = await import(
  "../../apps/mobile/src/app/(app)/(tabs)/(skills)/_layout"
);
const { default: SettingsStackLayout, unstable_settings: settingsSettings } = await import(
  "../../apps/mobile/src/app/(app)/(tabs)/(settings)/_layout"
);
const { ComposerBar } =
  platform === "ios"
    ? await import("../../apps/mobile/src/components/ComposerBar.ios")
    : await import("../../apps/mobile/src/components/ComposerBar");
const PairingScan =
  platform === "ios"
    ? (await import("../../apps/mobile/src/components/pairing/pairing-scan.ios")).PairingScanIos
    : (await import("../../apps/mobile/src/components/pairing/pairing-scan.fallback"))
        .PairingScanFallback;

function serializeControls(container: Element): SnapshotControl[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-a11y-node="true"]')).map(
    (element) => {
      const state: AccessibilityState = {};
      for (const [attribute, key] of [
        ["aria-busy", "busy"],
        ["aria-checked", "checked"],
        ["aria-disabled", "disabled"],
        ["aria-expanded", "expanded"],
        ["aria-selected", "selected"],
      ] as const) {
        const value = element.getAttribute(attribute);
        if (value === "true" || value === "false") {
          state[key] = value === "true";
        }
      }
      const minHeight = Number(element.dataset.minHeight);
      return {
        role: element.dataset.accessibilityRole ?? element.getAttribute("role") ?? "group",
        label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
        ...(element.dataset.accessibilityHint ? { hint: element.dataset.accessibilityHint } : {}),
        ...(element.dataset.accessibilityLive ? { live: element.dataset.accessibilityLive } : {}),
        ...(Number.isFinite(minHeight) ? { minHeight } : {}),
        ...(Object.keys(state).length > 0 ? { state } : {}),
      };
    },
  );
}

function serializeTextScaling(container: Element) {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-effective-font-scale]"))
    .map((element) => ({
      scale: Number(element.dataset.effectiveFontScale),
      text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }))
    .filter((entry) => entry.text.length > 0);
}

function stackScreens(container: Element, group: string): string[] {
  const wrapper = container.querySelector(`[data-stack-group="${group}"]`);
  if (!wrapper) {
    throw new Error(`Missing rendered stack ${group}`);
  }
  return Array.from(wrapper.querySelectorAll<HTMLElement>("[data-stack-screen]"))
    .map((element) => element.dataset.stackScreen ?? "")
    .filter(Boolean);
}

function buildNavigationSnapshot(container: Element) {
  const tabs = Array.from(container.querySelectorAll<HTMLElement>("[data-tab-route]")).map(
    (element) => {
      const icon = element.querySelector<HTMLElement>("[data-tab-icon-sf]");
      const iconValue = platform === "ios" ? icon?.dataset.tabIconSf : icon?.dataset.tabIconMd;
      return {
        badge: element.querySelector("[data-tab-badge]")?.textContent ?? null,
        icon: iconValue ? JSON.parse(iconValue) : null,
        label: element.querySelector("[data-tab-label]")?.textContent ?? "",
        route: element.dataset.tabRoute ?? "",
      };
    },
  );
  const stacks = {
    "(chats)": stackScreens(container, "(chats)"),
    "(settings)": stackScreens(container, "(settings)"),
    "(skills)": stackScreens(container, "(skills)"),
    "(workspace)": stackScreens(container, "(workspace)"),
  };
  const roots = {
    "(chats)": chatsSettings.initialRouteName,
    "(settings)": settingsSettings.initialRouteName,
    "(skills)": skillsSettings.initialRouteName,
    "(workspace)": workspaceSettings.initialRouteName,
  };
  const targets = {
    [MOBILE_DEEP_LINKS.chats]: { route: "(chats)", screen: "threads/index" },
    [MOBILE_DEEP_LINKS.thread]: { route: "(chats)", screen: "thread/[id]" },
    [MOBILE_DEEP_LINKS.settings]: { route: "(settings)", screen: "settings/index" },
    [MOBILE_DEEP_LINKS.settingsMcp]: { route: "(settings)", screen: "settings/mcp" },
    [MOBILE_DEEP_LINKS.settingsProviders]: {
      route: "(settings)",
      screen: "settings/providers",
    },
    [MOBILE_DEEP_LINKS.settingsUsage]: { route: "(settings)", screen: "settings/usage" },
    [MOBILE_DEEP_LINKS.skills]: { route: "(skills)", screen: "skills/index" },
    [MOBILE_DEEP_LINKS.workspace]: { route: "(workspace)", screen: "workspace/index" },
    [MOBILE_DEEP_LINKS.workspaceBackups]: {
      route: "(workspace)",
      screen: "workspace/backups",
    },
    [MOBILE_DEEP_LINKS.workspaceGeneral]: {
      route: "(workspace)",
      screen: "workspace/general",
    },
    [MOBILE_DEEP_LINKS.workspaceMemory]: {
      route: "(workspace)",
      screen: "workspace/memory",
    },
  } as const;

  for (const target of Object.values(targets)) {
    expect(stacks[target.route]).toContain(target.screen);
  }

  const state: Record<keyof typeof stacks, string[]> = {
    "(chats)": [roots["(chats)"]],
    "(settings)": [roots["(settings)"]],
    "(skills)": [roots["(skills)"]],
    "(workspace)": [roots["(workspace)"]],
  };
  const history: Array<keyof typeof stacks> = ["(chats)"];
  let active: keyof typeof stacks = "(chats)";
  const visit = (target: { route: keyof typeof stacks; screen: string }) => {
    active = target.route;
    history.push(active);
    if (state[active].at(-1) !== target.screen) {
      state[active].push(target.screen);
    }
  };
  visit(targets[MOBILE_DEEP_LINKS.workspaceGeneral]);
  visit(targets[MOBILE_DEEP_LINKS.settingsProviders]);
  active = "(workspace)";
  history.push(active);
  const preservedBeforeBack = structuredClone(state);
  state[active].pop();
  const activeAfterStackBack = active;
  history.pop();
  active = history.at(-1) ?? "(chats)";

  return {
    backBehavior: container
      .querySelector("[data-native-tabs-back-behavior]")
      ?.getAttribute("data-native-tabs-back-behavior"),
    deepLinks: targets,
    initialTab: tabSettings.initialRouteName,
    scenario: {
      activeAfterStackBack,
      activeAfterTabBack: active,
      preservedBeforeBack,
      stateAfterBack: state,
    },
    stacks,
    tabs,
  };
}

let approveCount = 0;
let rejectCount = 0;
let resolveApproval: ((value: boolean) => void) | null = null;
let resolveRejection: ((value: boolean) => void) | null = null;

function WorkflowTree() {
  const [switchValue, setSwitchValue] = useState(true);
  return createElement(
    "main",
    null,
    createElement(PairingScan),
    createElement(ComposerBar, {
      canEdit: true,
      canSubmit: false,
      isBusy: true,
      isStopping: false,
      isSubmitting: false,
      onChangeText: () => undefined,
      onStop: () => undefined,
      onSubmit: () => undefined,
      value: "Review this change",
    }),
    createElement(PendingRequestCard, {
      askDraft: "",
      onAnswerOption: () => undefined,
      onAnswerText: () => undefined,
      onApprove: () => {
        approveCount += 1;
        return new Promise<boolean>((resolve) => {
          resolveApproval = resolve;
        });
      },
      onChangeAskDraft: () => undefined,
      onReject: () => {
        rejectCount += 1;
        return new Promise<boolean>((resolve) => {
          resolveRejection = resolve;
        });
      },
      request: {
        command: "rm temp.txt",
        dangerous: true,
        itemId: "approval-item",
        kind: "approval",
        method: "item/commandExecution/requestApproval",
        reason: "Clean generated files",
        requestFingerprint: "approval-fingerprint",
        requestId: "approval-request",
        threadId: "thread-1",
      },
    }),
    createElement(GroupedSwitchRow, {
      description: "Include system and observability lines in chat transcripts.",
      isLast: true,
      label: "Show debug messages",
      onValueChange: setSwitchValue,
      value: switchValue,
    }),
    createElement(ReasoningCard, {
      mode: "reasoning",
      text: "First line\nSecond line\nThird line\nFourth line\nFifth line",
    }),
    createElement(ToolCallCard, {
      args: { command: "bun test", cwd: "/workspace", timeout: 60, verbose: true },
      name: "bash",
      result: { ok: true },
      state: "output-available",
    }),
    createElement(SourcesCarousel, {
      items: [{ href: "https://example.com/docs", label: "Example documentation" }],
    }),
  );
}

function NavigationTree() {
  return createElement(
    "div",
    null,
    createElement(AppTabsLayout),
    createElement("div", { "data-stack-group": "(chats)" }, createElement(ChatsStackLayout)),
    createElement(
      "div",
      { "data-stack-group": "(workspace)" },
      createElement(WorkspaceStackLayout),
    ),
    createElement("div", { "data-stack-group": "(skills)" }, createElement(SkillsStackLayout)),
    createElement("div", { "data-stack-group": "(settings)" }, createElement(SettingsStackLayout)),
  );
}

async function renderMotionTransform(
  root: ReturnType<typeof createRoot>,
  container: Element,
  reduced: boolean,
): Promise<string | null> {
  reducedMotionEnabled = reduced;
  await act(async () => {
    root.render(
      createElement(
        AppButton,
        {
          accessibilityLabel: reduced ? "Reduced motion probe" : "Standard motion probe",
          key: String(reduced),
          onPress: () => undefined,
          variant: "glass",
        },
        "Motion probe",
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return container.querySelector("button")?.getAttribute("data-pressed-transform") ?? null;
}

describe(`${platform} rendered mobile navigation and accessibility contract`, () => {
  test("renders native tabs, independent stacks, deep links, history back, and pending badge", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const container = harness.dom.window.document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(NavigationTree));
      });
      const snapshot = buildNavigationSnapshot(container);
      expect(snapshot.backBehavior).toBe("history");
      expect(snapshot.initialTab).toBe("(chats)");
      expect(snapshot.tabs.map(({ label, route }) => ({ label, route }))).toEqual(
        MOBILE_TABS.map(({ label, route }) => ({ label, route })),
      );
      expect(snapshot.tabs[0]?.badge).toBe("2");
      expect(snapshot.scenario.preservedBeforeBack["(workspace)"]).toEqual([
        "workspace/index",
        "workspace/general",
      ]);
      expect(snapshot.scenario.preservedBeforeBack["(settings)"]).toEqual([
        "settings/index",
        "settings/providers",
      ]);
      expect(snapshot.scenario.activeAfterStackBack).toBe("(workspace)");
      expect(snapshot.scenario.activeAfterTabBack).toBe("(settings)");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("matches the deterministic 200% accessibility tree and control behavior artifact", async () => {
    const harness = setupJsdom({ includeAnimationFrame: true });
    const container = harness.dom.window.document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(WorkflowTree));
        await Promise.resolve();
      });
      const initialControls = serializeControls(container);
      const initialTextScaling = serializeTextScaling(container);
      expect(initialControls.every((control) => control.label.trim().length > 0)).toBe(true);
      expect(initialTextScaling.every((entry) => entry.scale === fontScale)).toBe(true);
      expect(container.querySelector("[data-number-of-lines]")).toBeNull();

      const groupedSwitch = container.querySelector<HTMLElement>(
        '[aria-label="Show debug messages"]',
      );
      expect(groupedSwitch?.dataset.accessibilityRole).toBe("switch");
      expect(Number(groupedSwitch?.dataset.minHeight)).toBe(minimumTarget);
      expect(groupedSwitch?.querySelectorAll('[data-a11y-node="true"]').length).toBe(0);
      await act(async () => {
        groupedSwitch?.click();
      });
      expect(groupedSwitch?.getAttribute("aria-checked")).toBe("false");

      const approve = container.querySelector<HTMLElement>('[aria-label="Approve command"]');
      await act(async () => {
        approve?.click();
        approve?.click();
        await Promise.resolve();
      });
      expect(approveCount).toBe(1);
      const approvalBusyControls = serializeControls(container).filter(
        (control) =>
          control.label.includes("command") &&
          (control.label.includes("Approving") || control.label.includes("Decline")),
      );
      expect(
        container.querySelector('[aria-label="Approving command"]')?.getAttribute("aria-busy"),
      ).toBe("true");
      expect(
        container.querySelector('[aria-label="Decline command"]')?.getAttribute("aria-disabled"),
      ).toBe("true");
      resolveApproval?.(true);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const decline = container.querySelector<HTMLElement>('[aria-label="Decline command"]');
      await act(async () => {
        decline?.click();
        decline?.click();
        await Promise.resolve();
      });
      expect(rejectCount).toBe(1);
      const rejectionBusyControls = serializeControls(container).filter(
        (control) =>
          control.label.includes("command") &&
          (control.label.includes("Declining") || control.label.includes("Approve")),
      );
      expect(
        container.querySelector('[aria-label="Declining command"]')?.getAttribute("aria-busy"),
      ).toBe("true");
      expect(
        container.querySelector('[aria-label="Approve command"]')?.getAttribute("aria-disabled"),
      ).toBe("true");
      resolveRejection?.(true);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(announcements).toEqual(
        expect.arrayContaining([
          "Approving command",
          "Command approved",
          "Declining command",
          "Command declined",
        ]),
      );

      const navigationContainer = harness.dom.window.document.createElement("div");
      harness.dom.window.document.body.append(navigationContainer);
      const navigationRoot = createRoot(navigationContainer);
      await act(async () => {
        navigationRoot.render(createElement(NavigationTree));
      });
      const navigation = buildNavigationSnapshot(navigationContainer);
      await act(async () => {
        navigationRoot.unmount();
      });

      const standardMotionTransform = await renderMotionTransform(root, container, false);
      const reducedMotionTransform = await renderMotionTransform(root, container, true);
      const beforeLayoutAnimation = layoutAnimationCount;
      expect(runAccessibleLayoutAnimation(true)).toBe(false);
      expect(layoutAnimationCount).toBe(beforeLayoutAnimation);
      expect(runAccessibleLayoutAnimation(false)).toBe(true);
      expect(layoutAnimationCount).toBe(beforeLayoutAnimation + 1);
      expect(standardMotionTransform).toBe('[{"scale":0.985}]');
      expect(reducedMotionTransform).toBeNull();

      const snapshot = {
        accessibility: {
          approvalBusyControls,
          initialControls,
          initialTextScaling,
          rejectionBusyControls,
        },
        motion: {
          reducedMotionTransform,
          standardMotionTransform,
        },
        navigation,
        platform,
      };
      const snapshotPath = path.resolve(
        import.meta.dir,
        `../snapshots/mobile-accessibility.${platform}.json`,
      );
      if (process.env.UPDATE_MOBILE_ACCESSIBILITY_SNAPSHOTS === "1") {
        writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      } else {
        const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
        expect(snapshot).toEqual(expected);
      }
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });
});
