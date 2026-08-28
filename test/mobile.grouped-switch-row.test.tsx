import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type RowProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  accessibilityState?: { checked: boolean };
};
type SwitchProps = {
  value: boolean;
  onValueChange?: (value: boolean) => void;
  pointerEvents?: string;
  accessible?: boolean;
};

let platform = "android";
let rowProps: RowProps | undefined;
let switchProps: SwitchProps | undefined;
const changes: boolean[] = [];

function mockLocalModule(alias: string, relativePath: string, factory: () => unknown) {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(`${resolved}.ts`, factory);
  mock.module(`${resolved}.tsx`, factory);
}

mockLocalModule("react-native", "apps/mobile/node_modules/react-native", () => ({
  Platform: {
    get OS() {
      return platform;
    },
  },
  StyleSheet: { hairlineWidth: 0.5 },
  Pressable: (props: RowProps) => {
    rowProps = props;
    return createElement("button", null, props.children);
  },
  Switch: (props: SwitchProps) => {
    switchProps = props;
    return null;
  },
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  ScrollView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
mockLocalModule(
  "react-native-gesture-handler/Swipeable",
  "apps/mobile/node_modules/react-native-gesture-handler/Swipeable",
  () => ({ default: () => null }),
);
mockLocalModule(
  "@/features/accessibility/mobile-accessibility",
  "apps/mobile/src/features/accessibility/mobile-accessibility",
  () => ({ MAX_DYNAMIC_TYPE_MULTIPLIER: 2, minimumTouchTarget: () => 48 }),
);
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    primary: "#360",
    borderMuted: "#aaa",
    surfaceMuted: "#eee",
    text: "#111",
    textSecondary: "#222",
  }),
}));

const { GroupedSwitchRow } = await import("../apps/mobile/src/components/pairing/grouped-list");

function renderSwitch(value: boolean) {
  renderToStaticMarkup(
    createElement(GroupedSwitchRow, {
      label: "Show debug messages",
      description: "Include system messages.",
      value,
      onValueChange: (nextValue: boolean) => changes.push(nextValue),
    }),
  );
}

beforeEach(() => {
  rowProps = undefined;
  switchProps = undefined;
  changes.length = 0;
});

afterAll(() => mock.restore());

describe.each(["ios", "android"])("GroupedSwitchRow on %s", (os) => {
  beforeEach(() => {
    platform = os;
  });

  test.each([false, true])("handles native thumb changes from value=%s", (value) => {
    renderSwitch(value);
    expect(switchProps?.value).toBe(value);
    switchProps?.onValueChange?.(!value);
    expect(changes).toEqual([!value]);
    expect(switchProps?.pointerEvents).not.toBe("none");
  });

  test.each([false, true])("keeps the full row accessible and tappable from value=%s", (value) => {
    renderSwitch(value);
    expect(rowProps).toMatchObject({
      accessibilityRole: "switch",
      accessibilityLabel: "Show debug messages",
      accessibilityState: { checked: value },
    });
    expect(switchProps?.accessible).toBe(false);
    rowProps?.onPress?.();
    expect(changes).toEqual([!value]);
  });
});
