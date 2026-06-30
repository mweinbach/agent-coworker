import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";

mock.restore();

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
    danger: "#800",
    dangerMuted: "#fcc",
    shadow: "none",
  }),
}));

mock.module("../apps/mobile/src/components/thread/markdown-text", () => ({
  MarkdownText: ({ text }: { text: string }) =>
    createElement("markdown-text", { "data-text": text }),
}));

mock.module("../apps/mobile/src/components/thread/tool-call-card", () => ({
  ToolCallCard: ({ name }: { name: string }) => createElement("tool-card", { "data-name": name }),
}));

mock.module("../apps/mobile/src/components/thread/reasoning-card", () => ({
  ReasoningCard: ({ text }: { text: string }) =>
    createElement("reasoning-card", { "data-text": text }),
}));

mock.module("../apps/mobile/src/components/thread/todo-card", () => ({
  TodoCard: () => createElement("todo-card"),
}));

mock.module("../apps/mobile/src/components/thread/REMOVEDUI-surface-card", () => ({
  REMOVEDRemovedSurfaceCard: ({ item }: { item: { surfaceId: string } }) =>
    createElement("REMOVEDUI-surface-card", { "data-surface-id": item.surfaceId }),
}));

const { ThreadFeedItem } = await import("../apps/mobile/src/components/thread/thread-feed-item");

describe("mobile ThreadFeedItem", () => {
  test("renders REMOVED_SURFACE items with REMOVEDRemovedSurfaceCard instead of chrome fallback", () => {
    const rendered = ThreadFeedItem({
      item: {
        id: "RemovedSurface:s1",
        kind: "REMOVED_SURFACE",
        ts: "2026-04-19T00:00:00.000Z",
        surfaceId: "s1",
        catalogId: "https://REMOVEDUI.org/specification/v0_9/basic_catalog.json",
        version: "v0.9",
        revision: 1,
        deleted: false,
        root: { id: "root", type: "Column" },
      },
      REMOVEDUIEnabled: true,
      showDebugMessages: false,
    });

    expect(rendered.type).toBeDefined();
    expect(typeof rendered.type).toBe("function");
    expect((rendered.type as { name?: string }).name).toBe("REMOVEDRemovedSurfaceCard");
    expect(rendered.props.item.surfaceId).toBe("s1");
  });

  test("hides REMOVED_SURFACE items when REMOVEDUI is disabled", () => {
    const rendered = ThreadFeedItem({
      item: {
        id: "RemovedSurface:s1",
        kind: "REMOVED_SURFACE",
        ts: "2026-04-19T00:00:00.000Z",
        surfaceId: "s1",
        catalogId: "https://REMOVEDUI.org/specification/v0_9/basic_catalog.json",
        version: "v0.9",
        revision: 1,
        deleted: false,
        root: { id: "root", type: "Column" },
      },
      REMOVEDUIEnabled: false,
    });

    expect(rendered).toBeNull();
  });

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
        REMOVEDUIEnabled: true,
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
        REMOVEDUIEnabled: true,
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
      REMOVEDUIEnabled: true,
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
      REMOVEDUIEnabled: true,
      showDebugMessages: true,
    });
    expect(visible).not.toBeNull();
  });
});
