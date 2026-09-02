import { afterAll, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivityFeedItem } from "../apps/mobile/src/features/cowork/activityGroups";
import type { ToolFeedState } from "../apps/mobile/src/features/cowork/toolFeedState";

mock.restore();

const originalPlatform = process.env.EXPO_OS;
const actualReactNative = require("react-native");
const nativeHost =
  (tag: "div" | "span" | "button") =>
  ({
    children,
    accessibilityLabel,
    accessible,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessible?: boolean;
  }) =>
    createElement(
      tag,
      { "aria-label": accessibilityLabel, "data-accessible": accessible },
      children,
    );
const nativeComponents = () => ({
  ...actualReactNative,
  View: nativeHost("div"),
  Text: nativeHost("span"),
  ScrollView: nativeHost("div"),
  Pressable: nativeHost("button"),
});
mock.module("react-native", nativeComponents);
mock.module(path.resolve("apps/mobile/node_modules/react-native"), nativeComponents);

mock.module("@/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    border: "#111",
    borderMuted: "#222",
    primary: "#333",
    primaryText: "#fff",
    surface: "#444",
    surfaceMuted: "#555",
    text: "#666",
    textSecondary: "#777",
    textTertiary: "#888",
    success: "#080",
    warning: "#880",
    warningMuted: "#ffc",
    danger: "#800",
    dangerMuted: "#fcc",
    shadow: "none",
  }),
}));

mock.module("@/features/accessibility/mobile-accessibility", () => ({
  MAX_DYNAMIC_TYPE_MULTIPLIER: 2,
  minimumTouchTarget: () => (process.env.EXPO_OS === "ios" ? 44 : 48),
}));

mock.module("../apps/mobile/src/components/ui/sf-symbol", () => ({
  SFSymbol: () => createElement("span", { "aria-hidden": true }),
}));

mock.module("../apps/mobile/src/components/thread/markdown-text", () => ({
  MarkdownText: ({ text }: { text: string }) =>
    createElement("markdown-text", { "data-text": text }),
}));

mock.module("../apps/mobile/src/components/thread/todo-card", () => ({
  TodoCard: () => createElement("todo-card"),
}));

const { ThreadFeedItem } = await import("../apps/mobile/src/components/thread/thread-feed-item");
const { ActivityGroupCard } = await import(
  "../apps/mobile/src/components/thread/activity-group-card"
);
const { SubagentBar } = await import("../apps/mobile/src/components/thread/subagent-bar");

afterAll(() => {
  if (originalPlatform === undefined) {
    delete process.env.EXPO_OS;
  } else {
    process.env.EXPO_OS = originalPlatform;
  }
  mock.restore();
});

describe("mobile ThreadFeedItem", () => {
  test("hides reasoning and tool rows because activity groups render them", () => {
    expect(
      ThreadFeedItem({
        item: {
          id: "r1",
          kind: "reasoning",
          mode: "summary",
          ts: "2026-04-19T00:00:00.000Z",
          text: "Thinking",
        },
        showDebugMessages: false,
      }),
    ).toBeNull();

    expect(
      ThreadFeedItem({
        item: {
          id: "t1",
          kind: "tool",
          ts: "2026-04-19T00:00:01.000Z",
          name: "bash",
          state: "output-available",
        },
        showDebugMessages: false,
      }),
    ).toBeNull();
  });

  test("hides system debug lines unless showDebugMessages is enabled", () => {
    const hidden = ThreadFeedItem({
      item: {
        id: "s1",
        kind: "system",
        ts: "2026-04-19T00:00:00.000Z",
        line: "Observability: enabled=yes",
      },
      showDebugMessages: false,
    });
    expect(hidden).toBeNull();

    const visible = ThreadFeedItem({
      item: {
        id: "s1",
        kind: "system",
        ts: "2026-04-19T00:00:00.000Z",
        line: "Observability: enabled=yes",
      },
      showDebugMessages: true,
    });
    expect(visible).not.toBeNull();
  });
});

describe.each(["ios", "android"] as const)("mobile thread status semantics on %s", (platform) => {
  test("renders each tool's state as readable text with an explicit accessible label", () => {
    process.env.EXPO_OS = platform;
    const states: Array<{ state: ToolFeedState; label: string }> = [
      { state: "input-streaming", label: "Preparing" },
      { state: "input-available", label: "Running" },
      { state: "approval-requested", label: "Needs approval" },
      { state: "output-available", label: "Completed" },
      { state: "output-error", label: "Failed" },
      { state: "output-denied", label: "Denied" },
    ];
    const items: ActivityFeedItem[] = states.map(({ state }, index) => ({
      id: `tool-${state}`,
      kind: "tool",
      name: "read",
      state,
      args: { path: `notes-${index}.txt` },
      ts: `2026-09-01T00:00:0${index}.000Z`,
    }));

    const markup = renderToStaticMarkup(createElement(ActivityGroupCard, { items }));

    for (const { label } of states) {
      expect(markup).toContain(`aria-label="Tool status: ${label}" data-accessible="true"`);
      expect(markup).toContain(`>${label}</span>`);
    }
  });

  test("renders subagent names and states without depending on the status dot", () => {
    process.env.EXPO_OS = platform;
    const states = [
      { executionState: "pending_init", label: "Starting" },
      { executionState: "running", label: "Running" },
      { executionState: "completed", label: "Completed" },
      { executionState: "errored", label: "Failed" },
      { executionState: "idle", label: "Idle" },
      { executionState: "closed", label: "Closed" },
      { executionState: null, label: "Unknown" },
    ];
    const agents = states.map(({ executionState }, index) => ({
      sessionId: `agent-${index}`,
      nickname: `Reviewer ${index}`,
      executionState,
    }));

    const markup = renderToStaticMarkup(createElement(SubagentBar, { agents }));

    states.forEach(({ label }, index) => {
      expect(markup).toContain(`aria-label="Reviewer ${index}, ${label}" data-accessible="true"`);
      expect(markup).toContain(`>${label}</span>`);
    });
  });
});
