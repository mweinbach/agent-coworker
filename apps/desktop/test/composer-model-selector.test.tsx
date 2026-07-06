import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { ProviderName } from "../src/lib/wsProtocol";
import type { ComposerModelSelection } from "../src/ui/chat/ComposerModelSelector";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Mock desktopCommands before importing the store (which reads feature flags
// from it during initialization).
mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
    saveState: async () => {},
  }),
);

const { useAppStore } = await import("../src/app/store");
const { ComposerModelSelector } = await import("../src/ui/chat/ComposerModelSelector");

const defaultStoreState = useAppStore.getState();

const MODEL_DISPLAY_NAMES = {
  openai: {
    "gpt-5.5": "GPT-5.5",
    "gpt-5.4": "GPT-5.4",
  },
} as Record<ProviderName, Record<string, string>>;

function seedCatalog() {
  useAppStore.setState({
    providerCatalog: [
      {
        id: "openai",
        name: "OpenAI",
        models: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            description: "Frontier model for complex coding, reasoning, and agentic tasks.",
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
        defaultModel: "gpt-5.4",
      },
    ],
    providerConnected: ["openai"],
  });
}

function setupSelectorJsdom() {
  const harness = setupJsdom({
    includeAnimationFrame: true,
    extraGlobals: { ResizeObserver: MockResizeObserver },
  });
  // cmdk calls scrollIntoView on the selected item; jsdom doesn't implement it.
  harness.dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  return harness;
}

describe("ComposerModelSelector", () => {
  let harness: ReturnType<typeof setupSelectorJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    harness = setupSelectorJsdom();
    container = harness.dom.window.document.getElementById("root") as HTMLDivElement;
    root = createRoot(container);
    seedCatalog();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    useAppStore.setState(defaultStoreState);
    harness.restore();
  });

  async function renderSelector({
    defaultOpen = false,
    onChange = () => {},
  }: {
    defaultOpen?: boolean;
    onChange?: (selection: ComposerModelSelection) => void;
  } = {}) {
    await act(async () => {
      root.render(
        createElement(ComposerModelSelector, {
          provider: "openai",
          model: "gpt-5.5",
          modelDisplayNames: MODEL_DISPLAY_NAMES,
          defaultOpen,
          onChange,
        }),
      );
    });
  }

  test("trigger shows only the model display name, never the description", async () => {
    await renderSelector();

    const trigger = container.querySelector('[data-slot="composer-model-selector"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toBe("GPT-5.5");
    expect(trigger?.textContent).not.toContain("Frontier model");
  });

  test("open selector reveals a searchable list with descriptions", async () => {
    await renderSelector({ defaultOpen: true });

    const body = harness.dom.window.document.body;
    expect(body.querySelector('[data-slot="command-input"]')).not.toBeNull();
    const items = Array.from(body.querySelectorAll('[data-slot="command-item"]')).map((node) =>
      node.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(items.some((text) => text?.includes("GPT-5.5"))).toBe(true);
    expect(items.some((text) => text?.includes("Frontier model for complex coding"))).toBe(true);
    expect(items.some((text) => text?.includes("GPT-5.4"))).toBe(true);
  });

  test("model popover uses soft chrome instead of the default hard outline", async () => {
    await renderSelector({ defaultOpen: true });

    const body = harness.dom.window.document.body;
    const popover = body.querySelector('[data-slot="popover-content"]');
    const command = body.querySelector('[data-slot="command"]');

    expect(popover?.className).toContain("border-border/45");
    expect(popover?.className).toContain("shadow-foreground/10");
    expect(popover?.className).toContain("outline-none");
    expect(command?.className).toContain(
      "[&_[data-slot=command-input-wrapper]]:border-b-border/50",
    );
  });

  test("selecting a model fires onChange with the provider/model pair", async () => {
    const selections: ComposerModelSelection[] = [];
    await renderSelector({
      defaultOpen: true,
      onChange: (selection) => {
        selections.push(selection);
      },
    });

    const body = harness.dom.window.document.body;
    const target = Array.from(
      body.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
    ).find((node) => node.textContent?.includes("GPT-5.4"));
    if (!target) throw new Error("missing GPT-5.4 option");
    await act(async () => {
      target.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
    });

    expect(selections).toEqual([{ provider: "openai", model: "gpt-5.4" }]);
  });

  test("a selected but disabled built-in model is not labeled (custom)", async () => {
    // gpt-5.4 is a real catalog model that the user disabled; it drops out of
    // the picker choices but the current selection must still show without the
    // "(custom)" suffix reserved for user-added custom IDs.
    useAppStore.setState({
      providerCatalog: [
        {
          id: "openai",
          name: "OpenAI",
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
              enabled: false,
            },
          ],
          defaultModel: "gpt-5.5",
        },
      ],
      providerConnected: ["openai"],
    } as any);

    await act(async () => {
      root.render(
        createElement(ComposerModelSelector, {
          provider: "openai",
          model: "gpt-5.4",
          modelDisplayNames: MODEL_DISPLAY_NAMES,
          defaultOpen: true,
          onChange: () => {},
        }),
      );
    });

    const body = harness.dom.window.document.body;
    const items = Array.from(body.querySelectorAll('[data-slot="command-item"]')).map((node) =>
      node.textContent?.replace(/\s+/g, " ").trim(),
    );
    const currentRow = items.find((text) => text?.includes("GPT-5.4"));
    expect(currentRow).toBeDefined();
    expect(currentRow).not.toContain("(custom)");
  });

  test("a selected custom ID absent from the catalog is labeled (custom)", async () => {
    await act(async () => {
      root.render(
        createElement(ComposerModelSelector, {
          provider: "openai",
          model: "gpt-5.5-typed-custom",
          modelDisplayNames: MODEL_DISPLAY_NAMES,
          defaultOpen: true,
          onChange: () => {},
        }),
      );
    });

    const body = harness.dom.window.document.body;
    const items = Array.from(body.querySelectorAll('[data-slot="command-item"]')).map((node) =>
      node.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(
      items.some((text) => text?.includes("gpt-5.5-typed-custom") && text?.includes("(custom)")),
    ).toBe(true);
  });
});
