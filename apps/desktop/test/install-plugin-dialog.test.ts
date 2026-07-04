import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
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

const MOCK_UPDATE_STATE = {
  phase: "idle",
  currentVersion: "0.1.0",
  packaged: false,
  lastCheckedAt: null,
  release: null,
  progress: null,
  error: null,
};

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    appendTranscriptBatch: async () => {},
    appendTranscriptEvent: async () => {},
    deleteTranscript: async () => {},
    listDirectory: async () => [],
    loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
    pickWorkspaceDirectory: async () => null,
    readTranscript: async () => [],
    saveState: async () => {},
    startWorkspaceServer: async () => ({ url: "ws://mock" }),
    stopWorkspaceServer: async () => {},
    showContextMenu: async () => null,
    windowMinimize: async () => {},
    windowMaximize: async () => {},
    windowClose: async () => {},
    getPlatform: async () => "linux",
    readFile: async () => "",
    previewOSFile: async () => {},
    openPath: async () => {},
    openExternalUrl: async () => {},
    revealPath: async () => {},
    copyPath: async () => {},
    createDirectory: async () => {},
    renamePath: async () => {},
    trashPath: async () => {},
    confirmAction: async () => true,
    showNotification: async () => true,
    getSystemAppearance: async () => MOCK_SYSTEM_APPEARANCE,
    setWindowAppearance: async () => MOCK_SYSTEM_APPEARANCE,
    getUpdateState: async () => MOCK_UPDATE_STATE,
    checkForUpdates: async () => {},
    quitAndInstallUpdate: async () => {},
    onSystemAppearanceChanged: () => () => {},
    onMenuCommand: () => () => {},
    onUpdateStateChanged: () => () => {},
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const {
  InstallPluginDialog,
  shouldDisablePluginInstallForScope,
  shouldRequireFreshPluginPreviewForScope,
} = await import("../src/ui/settings/toolAccess/InstallPluginDialog");
mock.restore();

const workspaceId = "ws-plugins";

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function baseWorkspaceState() {
  return {
    workspaces: [
      {
        id: workspaceId,
        name: "Plugin Workspace",
        path: "/tmp/plugin-workspace",
        createdAt: "2026-03-30T00:00:00.000Z",
        lastOpenedAt: "2026-03-30T00:00:00.000Z",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    threads: [
      {
        id: "thread-1",
        workspaceId,
        title: "Thread 1",
        titleSource: "manual",
        createdAt: "2026-03-30T00:00:00.000Z",
        lastMessageAt: "2026-03-30T00:00:00.000Z",
        status: "active",
        sessionId: "session-1",
        messageCount: 1,
        lastEventSeq: 1,
        draft: false,
      },
    ],
    selectedWorkspaceId: workspaceId,
    selectedThreadId: "thread-1",
    selectThread: mock(async () => {}),
    newThread: mock(async () => {}),
    refreshPluginsCatalog: mock(async () => {}),
    selectPlugin: mock(async () => {}),
  };
}

describe("install plugin dialog", () => {
  test("new plugin dialog opens from a clean state", async () => {
    const previousState = useAppStore.getState();
    let root: ReturnType<typeof createRoot> | null = null;
    useAppStore.setState({
      ...baseWorkspaceState(),
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          selectedPluginPreview: {
            source: {
              kind: "local_path",
              raw: "/tmp/old-plugin",
              displaySource: "/tmp/old-plugin",
              localPath: "/tmp/old-plugin",
            },
            targetScope: "workspace",
            warnings: [],
            candidates: [
              {
                pluginId: "old-plugin",
                displayName: "Old Plugin",
                description: "Old preview should be cleared",
                relativeRootPath: ".",
                wouldBePrimary: true,
                diagnostics: [],
              },
            ],
          },
        },
      },
    } as any);

    const harness = setupJsdom();
    try {
      (
        harness.dom.window.HTMLElement.prototype as {
          attachEvent?: () => void;
          detachEvent?: () => void;
        }
      ).attachEvent = () => {};
      (
        harness.dom.window.HTMLElement.prototype as {
          attachEvent?: () => void;
          detachEvent?: () => void;
        }
      ).detachEvent = () => {};
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(InstallPluginDialog, { workspaceId, initialOpen: true }));
        await flushUi();
      });

      const dialogText = harness.dom.window.document.body.textContent ?? "";
      expect(dialogText).toContain("Install plugin from source");
      expect(dialogText).not.toContain("Old Plugin");
      expect(dialogText).not.toContain("/tmp/old-plugin");

      const textarea = harness.dom.window.document.querySelector("textarea");
      expect(textarea?.getAttribute("placeholder")).toContain(
        "https://github.com/example/codex-plugin-repo",
      );
      expect(textarea?.getAttribute("aria-label")).toBe("Plugin source");
      expect((textarea as HTMLTextAreaElement | null)?.value ?? "").toBe("");

      await act(async () => {
        root.unmount();
      });
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

  test("new plugin dialog renders a single error banner for plugin mutation failures", async () => {
    const previousState = useAppStore.getState();
    let root: ReturnType<typeof createRoot> | null = null;
    const previewPluginInstall = mock(async () => {});
    useAppStore.setState({
      ...baseWorkspaceState(),
      previewPluginInstall: previewPluginInstall as typeof previousState.previewPluginInstall,
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          pluginMutationError: "Plugin is shadowed by a global install.",
        },
      },
    } as any);

    const harness = setupJsdom();
    try {
      (
        harness.dom.window.HTMLElement.prototype as {
          attachEvent?: () => void;
          detachEvent?: () => void;
        }
      ).attachEvent = () => {};
      (
        harness.dom.window.HTMLElement.prototype as {
          attachEvent?: () => void;
          detachEvent?: () => void;
        }
      ).detachEvent = () => {};
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(InstallPluginDialog, {
            workspaceId,
            initialOpen: true,
            initialSourceInput: "owner/repo",
            initialMutationSourceInput: "owner/repo",
          }),
        );
        await flushUi();
      });

      const dialogText = harness.dom.window.document.body.textContent ?? "";
      expect(dialogText.match(/Plugin is shadowed by a global install\./g)?.length ?? 0).toBe(1);

      await act(async () => {
        root.unmount();
      });
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

  test("new plugin dialog keeps preview failures visible for the attempted source", async () => {
    const previousState = useAppStore.getState();
    let root: ReturnType<typeof createRoot> | null = null;
    const previewPluginInstall = mock(async () => {
      useAppStore.setState((state) => ({
        workspaceRuntimeById: {
          ...state.workspaceRuntimeById,
          [workspaceId]: {
            ...state.workspaceRuntimeById[workspaceId],
            pluginMutationError: "Unable to preview plugin install.",
          },
        },
      }));
    });
    useAppStore.setState({
      ...baseWorkspaceState(),
      previewPluginInstall: previewPluginInstall as typeof previousState.previewPluginInstall,
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          pluginMutationError: null,
        },
      },
    } as any);

    const harness = setupJsdom();
    try {
      (
        harness.dom.window.HTMLElement.prototype as {
          attachEvent?: () => void;
          detachEvent?: () => void;
        }
      ).attachEvent = () => {};
      (
        harness.dom.window.HTMLElement.prototype as {
          attachEvent?: () => void;
          detachEvent?: () => void;
        }
      ).detachEvent = () => {};
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(InstallPluginDialog, {
            workspaceId,
            initialOpen: true,
            initialSourceInput: "owner/repo",
          }),
        );
        await flushUi();
      });

      const previewButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Preview in Workspace"),
      );
      expect(previewButton).toBeDefined();

      await act(async () => {
        previewButton?.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
        await flushUi();
      });

      expect(previewPluginInstall).toHaveBeenCalledWith("owner/repo", "workspace");
      const dialogText = harness.dom.window.document.body.textContent ?? "";
      expect(dialogText.match(/Unable to preview plugin install\./g)?.length ?? 0).toBe(1);
      expect(dialogText).toContain("Last attempted target: workspace.");

      await act(async () => {
        root.unmount();
      });
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

  test("install dialog requires a fresh preview when switching install scope", () => {
    const preview = {
      source: {
        kind: "github_shorthand" as const,
        raw: "owner/repo",
        displaySource: "https://github.com/owner/repo",
        url: "https://github.com/owner/repo",
        repo: "owner/repo",
      },
      targetScope: "workspace" as const,
      candidates: [],
      warnings: [],
    };

    expect(
      shouldRequireFreshPluginPreviewForScope({
        normalizedSourceInput: "owner/repo",
        lastPreviewSourceInput: "owner/repo",
        lastPreviewTargetScope: "workspace",
        pluginPreview: preview,
        targetScope: "workspace",
      }),
    ).toBe(false);

    expect(
      shouldRequireFreshPluginPreviewForScope({
        normalizedSourceInput: "owner/repo",
        lastPreviewSourceInput: "owner/repo",
        lastPreviewTargetScope: "workspace",
        pluginPreview: preview,
        targetScope: "user",
      }),
    ).toBe(true);
  });

  test("install dialog disables install when the active preview has no valid candidates", () => {
    const invalidPreview = {
      source: {
        kind: "github_shorthand" as const,
        raw: "owner/repo",
        displaySource: "https://github.com/owner/repo",
        url: "https://github.com/owner/repo",
        repo: "owner/repo",
      },
      targetScope: "workspace" as const,
      candidates: [
        {
          pluginId: "broken-plugin",
          displayName: "Broken Plugin",
          description: "Broken plugin",
          relativeRootPath: ".",
          wouldBePrimary: true,
          diagnostics: [
            {
              code: "invalid_plugin_manifest",
              severity: "error" as const,
              message: "Invalid plugin manifest",
            },
          ],
        },
      ],
      warnings: [],
    };

    expect(
      shouldDisablePluginInstallForScope({
        normalizedSourceInput: "owner/repo",
        lastPreviewSourceInput: "owner/repo",
        lastPreviewTargetScope: "workspace",
        pluginPreview: invalidPreview,
        targetScope: "workspace",
        pluginInstallInFlight: false,
      }),
    ).toBe(true);

    expect(
      shouldDisablePluginInstallForScope({
        normalizedSourceInput: "owner/repo",
        lastPreviewSourceInput: "owner/repo",
        lastPreviewTargetScope: "workspace",
        pluginPreview: invalidPreview,
        targetScope: "user",
        pluginInstallInFlight: false,
      }),
    ).toBe(true);

    const validPreview = {
      ...invalidPreview,
      candidates: [
        {
          ...invalidPreview.candidates[0],
          diagnostics: [],
        },
      ],
    };

    expect(
      shouldDisablePluginInstallForScope({
        normalizedSourceInput: "owner/repo",
        lastPreviewSourceInput: "owner/repo",
        lastPreviewTargetScope: "workspace",
        pluginPreview: validPreview,
        targetScope: "workspace",
        pluginInstallInFlight: false,
      }),
    ).toBe(false);

    const multiPluginPreview = {
      ...validPreview,
      candidates: [
        validPreview.candidates[0],
        {
          ...validPreview.candidates[0],
          pluginId: "second-plugin",
          displayName: "Second Plugin",
        },
      ],
    };

    expect(
      shouldDisablePluginInstallForScope({
        normalizedSourceInput: "owner/repo",
        lastPreviewSourceInput: "owner/repo",
        lastPreviewTargetScope: "workspace",
        pluginPreview: multiPluginPreview,
        targetScope: "workspace",
        pluginInstallInFlight: false,
      }),
    ).toBe(true);
  });
});
