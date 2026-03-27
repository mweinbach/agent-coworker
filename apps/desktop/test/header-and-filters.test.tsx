import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "./jsdomHarness";

mock.module("../src/ui/skills/InstallSkillDialog", () => ({
  InstallSkillDialog: () => createElement("div", null, "install-skill"),
}));

const { useAppStore } = await import("../src/app/store");
const { HeaderAndFilters } = await import("../src/ui/skills/HeaderAndFilters");
mock.restore();

async function waitForTextContent(
  container: HTMLElement,
  predicate: (text: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = container.textContent ?? "";
    if (predicate(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return container.textContent ?? "";
}

describe("skills header and filters", () => {
  test("shows workspace context without the current chat callout", async () => {
    const harness = setupJsdom();
    const previousState = useAppStore.getState();

    useAppStore.setState({
      ...previousState,
      workspaces: [{
        id: "ws-1",
        name: "Cowork Test",
        path: "/tmp/cowork-test",
        createdAt: "2026-03-24T00:00:00.000Z",
        lastOpenedAt: "2026-03-24T00:00:00.000Z",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        defaultPreferredChildModel: "gpt-5.4",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      }],
      threads: [{
        id: "thread-1",
        workspaceId: "ws-1",
        title: "Micron Post-Earnings Analysis Report",
        titleSource: "manual",
        createdAt: "2026-03-24T00:00:00.000Z",
        lastMessageAt: "2026-03-24T00:10:00.000Z",
        status: "active",
        sessionId: "session-1",
        messageCount: 3,
        lastEventSeq: 3,
        draft: false,
      }],
      selectedThreadId: "thread-1",
      refreshSkillsCatalog: mock(() => Promise.resolve()),
      selectThread: mock(() => Promise.resolve()),
      newThread: mock(() => Promise.resolve()),
    } as any);

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(HeaderAndFilters, {
            workspaceId: "ws-1",
            searchQuery: "",
            setSearchQuery: () => {},
          }),
        );
      });

      const text = await waitForTextContent(
        container,
        (value) =>
          value.includes("Skills for")
          && value.includes("Cowork Test")
          && value.includes("1 session")
          && value.includes("Open chat")
          && value.includes("Refresh"),
      );

      expect(text).toContain("Skills for");
      expect(text).toContain("Cowork Test");
      expect(text).toContain("1 session");
      expect(text).not.toContain("Current chat");
      expect(text).toContain("Open chat");
      expect(text).toContain("Refresh");

      await act(async () => {
        root.unmount();
      });
    } finally {
      useAppStore.setState(previousState);
      harness.restore();
    }
  });
});
