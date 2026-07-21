import { describe, expect, mock, test } from "bun:test";
import { act, createElement, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const MOCK_SYSTEM_APPEARANCE = {
  platform: "linux",
  themeSource: "system",
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  prefersReducedTransparency: false,
  inForcedColorsMode: false,
};

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    getSystemAppearance: async () => MOCK_SYSTEM_APPEARANCE,
    setWindowAppearance: async () => MOCK_SYSTEM_APPEARANCE,
    onSystemAppearanceChanged: () => () => {},
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { ActivityGroupCard } = await import("../src/ui/chat/ActivityGroupCard");

describe("LiveTimerLabel re-render isolation", () => {
  test("<LiveTimerLabel> 1-second interval updates isolate re-renders to the timer node and do not re-render ActivityGroupCard parent", async () => {
    const harness = setupJsdom();
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);

      const activityItems = [
        {
          id: "t1",
          kind: "tool" as const,
          ts: new Date(Date.now() - 5000).toISOString(),
          name: "read",
          state: "running" as const,
          args: { path: "test.ts" },
        },
      ];

      let activityCardRenderCount = 0;
      let profilerRenderCount = 0;

      // Wrap ActivityGroupCard to track its render executions
      function TrackedActivityGroupCard(props: Parameters<typeof ActivityGroupCard>[0]) {
        activityCardRenderCount++;
        return createElement(ActivityGroupCard, props);
      }

      const onRender = (
        id: string,
        phase: "mount" | "update",
        actualDuration: number,
        baseDuration: number,
        startTime: number,
        commitTime: number,
      ) => {
        profilerRenderCount++;
      };

      await act(async () => {
        root.render(
          createElement(
            Profiler,
            { id: "ActivityGroupCardTree", onRender },
            createElement(TrackedActivityGroupCard, {
              live: true,
              items: activityItems,
              liveStartedAt: new Date(Date.now() - 5000).toISOString(),
            }),
          ),
        );
      });

      // Initial mount checks
      expect(activityCardRenderCount).toBe(1);
      expect(container.textContent).toContain("Working for");

      const initialText = container.textContent;

      // Advance clock by 2.5 seconds using setInterval ticks
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
      });

      const updatedText = container.textContent;

      // Verify that ActivityGroupCard itself did NOT re-render during timer ticks
      expect(activityCardRenderCount).toBe(1);

      // Verify that text inside LiveTimerLabel updated as time elapsed
      expect(updatedText).toContain("Working for");
      // Verify timer isolation: text content changed/updated while parent render count remained 1
      expect(profilerRenderCount).toBeGreaterThanOrEqual(2);

      await act(async () => {
        root.unmount();
      });
      container.remove();
    } finally {
      harness.restore();
    }
  });
});
