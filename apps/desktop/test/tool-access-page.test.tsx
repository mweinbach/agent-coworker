import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());

const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const { ToolAccessCatalogSections, useToolAccessCatalogWorkspaceId } = await import(
  "../src/ui/settings/pages/ToolAccessPage"
);
const { managementWorkspaceIdFor } = await import("../src/app/store.actions/skillPluginHelpers");
mock.restore();

const PLUGIN_MUTATION_ERROR = "Plugin install failed: marketplace source hash mismatch.";
const SKILL_MUTATION_ERROR = "Skill install failed: GitHub rate limit exceeded.";

describe("tool access catalog sections", () => {
  test("renders skill and plugin mutation errors and clears them on dismiss", async () => {
    const previousState = useAppStore.getState();
    const refreshPluginsCatalogMock = mock(async () => {});
    const refreshSkillsCatalogMock = mock(async (_workspaceId?: string) => {});

    useAppStore.setState({
      ...previousState,
      refreshPluginsCatalog:
        refreshPluginsCatalogMock as typeof previousState.refreshPluginsCatalog,
      refreshSkillsCatalog: refreshSkillsCatalogMock as typeof previousState.refreshSkillsCatalog,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginMutationError: PLUGIN_MUTATION_ERROR,
          skillMutationError: SKILL_MUTATION_ERROR,
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessCatalogSections, { workspaceId: "ws-1" }));
      });

      const bodyText = () => harness.dom.window.document.body.textContent ?? "";
      expect(bodyText()).toContain("Install failed");
      expect(bodyText()).toContain(PLUGIN_MUTATION_ERROR);
      expect(bodyText()).toContain(SKILL_MUTATION_ERROR);

      const dismissButtons = () =>
        Array.from(harness.dom.window.document.querySelectorAll("button")).filter(
          (button) => button.textContent?.trim() === "Dismiss",
        );
      expect(dismissButtons()).toHaveLength(2);

      // The plugin banner renders first; dismissing it must not clear the skill error.
      const pluginDismiss = dismissButtons()[0];
      if (!(pluginDismiss instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing plugin dismiss button");
      }
      await act(async () => {
        pluginDismiss.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(useAppStore.getState().workspaceRuntimeById["ws-1"]?.pluginMutationError).toBeNull();
      expect(useAppStore.getState().workspaceRuntimeById["ws-1"]?.skillMutationError).toBe(
        SKILL_MUTATION_ERROR,
      );
      expect(bodyText()).not.toContain(PLUGIN_MUTATION_ERROR);
      expect(bodyText()).toContain(SKILL_MUTATION_ERROR);

      const skillDismiss = dismissButtons()[0];
      if (!(skillDismiss instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing skill dismiss button");
      }
      await act(async () => {
        skillDismiss.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(useAppStore.getState().workspaceRuntimeById["ws-1"]?.skillMutationError).toBeNull();
      expect(bodyText()).not.toContain(SKILL_MUTATION_ERROR);
      expect(bodyText()).not.toContain("Install failed");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("chat-only workspaces still anchor the catalog and marketplace installs", async () => {
    const previousState = useAppStore.getState();
    const refreshPluginsCatalogMock = mock(async () => {});
    const refreshSkillsCatalogMock = mock(async (_workspaceId?: string) => {});
    const installPluginsMock = mock(
      async (_sourceInput: string, _targetScope: "workspace" | "user") => {},
    );
    const installSkillsMock = mock(
      async (_sourceInput: string, _targetScope: "project" | "global") => {},
    );

    const chatWorkspace = {
      id: "chat-1",
      name: "New chat",
      path: "/tmp/home/.cowork/chats/chat-1",
      workspaceKind: "oneOffChat" as const,
      createdAt: "2026-06-02T00:00:00.000Z",
      lastOpenedAt: "2026-06-02T00:00:00.000Z",
      defaultEnableMcp: true,
      defaultBackupsEnabled: false,
      yolo: false,
    };

    useAppStore.setState({
      ...previousState,
      workspaces: [chatWorkspace],
      selectedWorkspaceId: "chat-1",
      refreshPluginsCatalog:
        refreshPluginsCatalogMock as typeof previousState.refreshPluginsCatalog,
      refreshSkillsCatalog: refreshSkillsCatalogMock as typeof previousState.refreshSkillsCatalog,
      installPlugins: installPluginsMock as typeof previousState.installPlugins,
      installSkills: installSkillsMock as typeof previousState.installSkills,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "chat-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            plugins: [],
            availablePlugins: [
              {
                id: "cursor-team-kit",
                name: "cursor-team-kit",
                displayName: "Cursor Team Kit",
                description: "Shared team workflows.",
                scope: "user",
                discoveryKind: "marketplace",
                installed: false,
                enabled: false,
                installSource:
                  "https://github.com/example/cowork-plugins/tree/main/plugins/cursor-team-kit",
                marketplace: { name: "example-marketplace", category: "Productivity" },
                warnings: [],
              },
            ],
            warnings: [],
          },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [],
            availableSkills: [
              {
                id: "imagegen",
                name: "imagegen",
                displayName: "Imagegen",
                description: "Generate images.",
                category: "Creative",
                scope: "user",
                discoveryKind: "marketplace",
                installed: false,
                enabled: false,
                installSource: "https://skills.sh/example/skills/imagegen",
                marketplace: { name: "example-marketplace", category: "Creative" },
                warnings: [],
              },
            ],
          },
        },
      },
    });

    // The store-side anchor used by plugin/skill actions resolves to the chat
    // workspace instead of null, so installs are no longer silent no-ops.
    expect(managementWorkspaceIdFor(useAppStore.getState)).toBe("chat-1");

    const CatalogHarness = () => {
      const workspaceId = useToolAccessCatalogWorkspaceId();
      return workspaceId
        ? createElement(ToolAccessCatalogSections, { workspaceId })
        : createElement("div", null, "catalog-empty-state");
    };

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(CatalogHarness));
      });

      const bodyText = harness.dom.window.document.body.textContent ?? "";
      expect(bodyText).not.toContain("catalog-empty-state");
      expect(bodyText).toContain("Marketplace");
      expect(bodyText).toContain("Cursor Team Kit");
      expect(bodyText).toContain("Imagegen");

      const installButtons = Array.from(
        harness.dom.window.document.querySelectorAll("button"),
      ).filter((button) => button.textContent?.trim() === "Install");
      expect(installButtons).toHaveLength(2);

      for (const button of installButtons) {
        if (!(button instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error("missing marketplace install button");
        }
        await act(async () => {
          button.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        });
      }

      expect(installPluginsMock).toHaveBeenCalledWith(
        "https://github.com/example/cowork-plugins/tree/main/plugins/cursor-team-kit",
        "user",
      );
      expect(installSkillsMock).toHaveBeenCalledWith(
        "https://skills.sh/example/skills/imagegen",
        "global",
      );
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("marketplace install button attaches a rejection handler for failed installs", async () => {
    const previousState = useAppStore.getState();
    const refreshPluginsCatalogMock = mock(async () => {});
    const refreshSkillsCatalogMock = mock(async (_workspaceId?: string) => {});
    let rejectionHandled = false;
    const installPluginsMock = mock(
      (_sourceInput: string, _targetScope: "workspace" | "user") =>
        ({
          catch(onRejected?: (error: unknown) => void) {
            rejectionHandled = typeof onRejected === "function";
            return Promise.resolve();
          },
        }) as unknown as Promise<void>,
    );

    useAppStore.setState({
      ...previousState,
      refreshPluginsCatalog:
        refreshPluginsCatalogMock as typeof previousState.refreshPluginsCatalog,
      refreshSkillsCatalog: refreshSkillsCatalogMock as typeof previousState.refreshSkillsCatalog,
      installPlugins: installPluginsMock as typeof previousState.installPlugins,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          pluginsCatalog: {
            plugins: [],
            availablePlugins: [
              {
                id: "cursor-team-kit",
                name: "cursor-team-kit",
                displayName: "Cursor Team Kit",
                description: "Shared team workflows.",
                scope: "user",
                discoveryKind: "marketplace",
                installed: false,
                enabled: false,
                installSource:
                  "https://github.com/example/cowork-plugins/tree/main/plugins/cursor-team-kit",
                marketplace: { name: "example-marketplace", category: "Productivity" },
                warnings: [],
              },
            ],
            warnings: [],
          },
          skillsCatalog: {
            scopes: [],
            effectiveSkills: [],
            installations: [],
            availableSkills: [],
          },
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(ToolAccessCatalogSections, { workspaceId: "ws-1" }));
      });

      const installButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Install",
      );
      if (!(installButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing marketplace install button");
      }

      await act(async () => {
        installButton.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
      });

      expect(installPluginsMock).toHaveBeenCalledWith(
        "https://github.com/example/cowork-plugins/tree/main/plugins/cursor-team-kit",
        "user",
      );
      expect(rejectionHandled).toBe(true);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });
});
