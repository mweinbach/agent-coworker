import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import { installDesktopCommandsBridge } from "./helpers/desktopCommandsBridge";
import {
  clearJsonRpcSocketOverride,
  NoopJsonRpcSocket,
  setJsonRpcSocketOverride,
} from "./helpers/jsonRpcSocketMock";
import { createDesktopApiMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

installDesktopCommandsBridge();

const desktopApiMock = createDesktopApiMock();

const { useAppStore } = await import("../src/app/store");
const { ManageModelsDialog } = await import("../src/ui/settings/pages/ManageModelsDialog");
const { MODEL_CHOICES } = await import("../src/lib/modelChoices");

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
    (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] = desktopApiMock;
    setJsonRpcSocketOverride(NoopJsonRpcSocket);
    useAppStore.setState({ providerCatalog: CATALOG });
  });

  afterEach(() => {
    clearJsonRpcSocketOverride();
    delete (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY];
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

  test("falls back to the static registry when the catalog entry has no models", async () => {
    const harness = setupJsdom();
    // Entry without a models list — the catalog can lag behind discovery.
    useAppStore.setState({
      providerCatalog: [{ id: "anthropic", name: "Anthropic" }] as any,
    });

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(ManageModelsDialog, {
            provider: "anthropic" as const,
            onOpenChange: () => {},
          }),
        );
      });

      const doc = harness.dom.window.document;
      const staticIds = MODEL_CHOICES.anthropic;
      expect(staticIds.length).toBeGreaterThan(0);
      expect(doc.body.textContent).not.toContain("No models discovered yet.");
      expect(doc.body.textContent).toContain(staticIds[0]);
      const checkboxes = [...doc.querySelectorAll('[role="checkbox"]')];
      expect(checkboxes).toHaveLength(staticIds.length);
      // Static fallback models default to enabled.
      expect(doc.body.textContent).toContain(`${staticIds.length} of ${staticIds.length} enabled`);

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
      // Mirror the real action: the RPC response carries the refreshed
      // catalog, so apply the change to providerCatalog before resolving.
      setProviderModelsEnabled: (async (
        provider: string,
        models: Array<{ id: string; enabled: boolean }>,
      ) => {
        calls.push({ provider, models });
        const changed = new Map(models.map((model) => [model.id, model.enabled] as const));
        useAppStore.setState((s: any) => ({
          providerCatalog: s.providerCatalog.map((entry: any) =>
            entry.id === provider
              ? {
                  ...entry,
                  models: entry.models.map((model: any) =>
                    changed.has(model.id) ? { ...model, enabled: changed.get(model.id) } : model,
                  ),
                }
              : entry,
          ),
        }));
        return { ok: true, value: undefined };
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
        return { ok: true, value: undefined };
      }) as any,
      resetProviderModelPreferences: (async (provider: string) => {
        resetCalls.push(provider);
        return { ok: true, value: undefined };
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

  test("blocks reset while a model toggle is in flight", async () => {
    const harness = setupJsdom();
    // setEnabled never resolves, so the optimistic pending entry lingers and
    // disagrees with the (unchanged) catalog — the scenario the reconcile keeps.
    useAppStore.setState({
      setProviderModelsEnabled: (() => new Promise(() => {})) as any,
      resetProviderModelPreferences: (async () => ({
        ok: true,
        value: undefined,
      })) as any,
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
      // GLM-5.2 is enabled in the seeded catalog; disable it (pending off).
      const disable = doc.querySelector<HTMLElement>('[aria-label="Disable zai-org/GLM-5.2"]');
      expect(disable).not.toBeNull();
      await act(async () => {
        disable?.click();
      });
      expect(
        doc.querySelector('[aria-label="Enable zai-org/GLM-5.2"]')?.getAttribute("aria-checked"),
      ).toBe("false");

      const reset = [...doc.querySelectorAll("button")].find(
        (el) => el.textContent === "Reset to defaults",
      );
      expect(reset?.hasAttribute("disabled")).toBe(true);

      // The pending intent remains visible until its acknowledged result lands.
      expect(
        doc.querySelector('[aria-label="Enable zai-org/GLM-5.2"]')?.getAttribute("aria-checked"),
      ).toBe("false");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });
});
