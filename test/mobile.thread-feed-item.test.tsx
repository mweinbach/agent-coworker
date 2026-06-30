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

const { ThreadFeedItem } = await import("../apps/mobile/src/components/thread/thread-feed-item");

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
