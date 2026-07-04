import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock({}));
mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { ManageModelsDialog } = await import("../src/ui/settings/pages/ManageModelsDialog");

const CATALOG = [
  {
    id: "together",
    name: "Together AI",
    models: [
      { id: "zai-org/GLM-5.2", displayName: "GLM 5.2" },
      { id: "some-org/obscure-model", displayName: "Obscure Model", enabled: false },
      {
        id: "my-custom-model",
        displayName: "my-custom-model",
        runtimeOptions: { source: "custom" },
      },
    ],
    defaultModel: "zai-org/GLM-5.2",
  },
] as any;

describe("manage models dialog", () => {
  beforeEach(() => {
    useAppStore.setState({ providerCatalog: CATALOG });
  });

  test("lists every model with its enabled state and custom badge", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(ManageModelsDialog, {
            provider: "together" as const,
            onOpenChange: () => {},
          }),
        );
      });

      const doc = harness.dom.window.document;
      expect(doc.body.textContent).toContain("Manage Together AI models");
      expect(doc.body.textContent).toContain("2 of 3 enabled");
      expect(doc.body.textContent).toContain("GLM 5.2");
      expect(doc.body.textContent).toContain("Obscure Model");
      expect(doc.body.textContent).toContain("Custom");

      const checkboxes = [...doc.querySelectorAll('[role="checkbox"]')];
      expect(checkboxes).toHaveLength(3);
      expect(checkboxes.map((el) => el.getAttribute("aria-checked"))).toEqual([
        "true",
        "false",
        "true",
      ]);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("toggling a checkbox sends the model preference update", async () => {
    const harness = setupJsdom();
    const calls: Array<{ provider: string; models: unknown }> = [];
    useAppStore.setState({
      setProviderModelsEnabled: (async (provider: string, models: unknown) => {
        calls.push({ provider, models });
      }) as any,
    });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(ManageModelsDialog, {
            provider: "together" as const,
            onOpenChange: () => {},
          }),
        );
      });

      const doc = harness.dom.window.document;
      const disableTarget = doc.querySelector<HTMLElement>(
        '[aria-label="Disable zai-org/GLM-5.2"]',
      );
      expect(disableTarget).not.toBeNull();
      await act(async () => {
        disableTarget?.click();
      });

      expect(calls).toEqual([
        { provider: "together", models: [{ id: "zai-org/GLM-5.2", enabled: false }] },
      ]);
      expect(disableTarget?.getAttribute("aria-checked")).toBe("false");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("enable all sends a bulk update for the filtered set and reset clears overrides", async () => {
    const harness = setupJsdom();
    const setCalls: Array<{ provider: string; models: unknown }> = [];
    const resetCalls: string[] = [];
    useAppStore.setState({
      setProviderModelsEnabled: (async (provider: string, models: unknown) => {
        setCalls.push({ provider, models });
      }) as any,
      resetProviderModelPreferences: (async (provider: string) => {
        resetCalls.push(provider);
      }) as any,
    });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(ManageModelsDialog, {
            provider: "together" as const,
            onOpenChange: () => {},
          }),
        );
      });

      const doc = harness.dom.window.document;
      const buttons = [...doc.querySelectorAll("button")];
      const enableAll = buttons.find((el) => el.textContent === "Enable all");
      const reset = buttons.find((el) => el.textContent === "Reset to defaults");
      expect(enableAll).toBeDefined();
      expect(reset).toBeDefined();

      await act(async () => {
        enableAll?.click();
      });
      expect(setCalls).toEqual([
        {
          provider: "together",
          models: [
            { id: "zai-org/GLM-5.2", enabled: true },
            { id: "some-org/obscure-model", enabled: true },
            { id: "my-custom-model", enabled: true },
          ],
        },
      ]);

      await act(async () => {
        reset?.click();
      });
      expect(resetCalls).toEqual(["together"]);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
