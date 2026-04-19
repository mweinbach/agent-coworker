import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";

mock.module("react-native", () => ({
  View: ({ children, ...props }: Record<string, unknown>) => createElement("view", props, children),
  Text: ({ children, ...props }: Record<string, unknown>) => createElement("text", props, children),
}));

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
  MarkdownText: ({ text }: { text: string }) => createElement("markdown-text", { "data-text": text }),
}));

mock.module("../apps/mobile/src/components/thread/tool-call-card", () => ({
  ToolCallCard: ({ name }: { name: string }) => createElement("tool-card", { "data-name": name }),
}));

mock.module("../apps/mobile/src/components/thread/reasoning-card", () => ({
  ReasoningCard: ({ text }: { text: string }) => createElement("reasoning-card", { "data-text": text }),
}));

mock.module("../apps/mobile/src/components/thread/todo-card", () => ({
  TodoCard: () => createElement("todo-card"),
}));

mock.module("../apps/mobile/src/components/thread/a2ui-surface-card", () => ({
  A2uiSurfaceCard: ({ item }: { item: { surfaceId: string } }) =>
    createElement("a2ui-surface-card", { "data-surface-id": item.surfaceId }),
}));

const { ThreadFeedItem } = await import("../apps/mobile/src/components/thread/thread-feed-item");

describe("mobile ThreadFeedItem", () => {
  test("renders ui_surface items with A2uiSurfaceCard instead of chrome fallback", () => {
    const rendered = ThreadFeedItem({
      item: {
        id: "uiSurface:s1",
        kind: "ui_surface",
        ts: "2026-04-19T00:00:00.000Z",
        surfaceId: "s1",
        catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
        version: "v0.9",
        revision: 1,
        deleted: false,
        root: { id: "root", type: "Column" },
      },
    });

    expect(rendered.type).toBeDefined();
    expect(typeof rendered.type).toBe("function");
    expect((rendered.type as { name?: string }).name).toBe("A2uiSurfaceCard");
    expect(rendered.props.item.surfaceId).toBe("s1");
  });
});
