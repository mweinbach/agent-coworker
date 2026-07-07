import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ProviderName } from "../src/lib/wsProtocol";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
    saveState: async () => {},
  }),
);

const { useAppStore } = await import("../src/app/store");
const { ThreadModelSelector } = await import("../src/ui/chat/ThreadModelSelector");

const defaultStoreState = useAppStore.getState();
const MODEL_DISPLAY_NAMES = {
  openai: {
    "gpt-5.5": "GPT-5.5",
    "gpt-5.4": "GPT-5.4",
  },
} as Record<ProviderName, Record<string, string>>;

function setupSelectorJsdom() {
  const harness = setupJsdom({
    includeAnimationFrame: true,
    extraGlobals: { ResizeObserver: MockResizeObserver },
  });
  harness.dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  return harness;
}

describe("ThreadModelSelector", () => {
  let harness: ReturnType<typeof setupSelectorJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    harness = setupSelectorJsdom();
    container = harness.dom.window.document.getElementById("root") as HTMLDivElement;
    root = createRoot(container);
    useAppStore.setState({
      providerCatalog: [
        {
          id: "openai",
          name: "OpenAI",
          defaultModel: "gpt-5.5",
          models: [
            {
              id: "gpt-5.5",
              displayName: "GPT-5.5",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
            },
            {
              id: "gpt-5.4",
              displayName: "GPT-5.4",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
            },
          ],
        },
      ],
      providerConnected: ["openai"],
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    useAppStore.setState(defaultStoreState);
    harness.restore();
  });

  test("changes an existing thread model through the shared selector", async () => {
    const setThreadModel = mock(() => {});
    useAppStore.setState({ setThreadModel });

    await act(async () => {
      root.render(
        createElement(ThreadModelSelector, {
          threadId: "thread-1",
          provider: "openai",
          model: "gpt-5.5",
          modelDisplayNames: MODEL_DISPLAY_NAMES,
          defaultOpen: true,
        }),
      );
    });

    const target = Array.from(
      harness.dom.window.document.body.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
    ).find((node) => node.textContent?.includes("GPT-5.4"));
    if (!target) throw new Error("missing GPT-5.4 option");
    await act(async () => {
      target.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
    });

    expect(setThreadModel).toHaveBeenCalledWith("thread-1", "openai", "gpt-5.4");
  });

  test("disables the selector while a thread cannot change models", async () => {
    await act(async () => {
      root.render(
        createElement(ThreadModelSelector, {
          threadId: "thread-1",
          provider: "openai",
          model: "gpt-5.5",
          modelDisplayNames: MODEL_DISPLAY_NAMES,
          disabled: true,
        }),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="composer-model-selector"]',
    );
    expect(trigger?.disabled).toBe(true);
  });
});
