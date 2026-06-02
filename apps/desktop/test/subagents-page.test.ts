import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type {
  AgentProfileCatalogEntry,
  AgentProfileScope,
} from "../../../src/shared/agentProfiles";
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

const { ProfileDialog, SubagentsPage, resolveSubagentProfilesWorkspace, saveAgentProfileDraft } =
  await import("../src/ui/settings/pages/SubagentsPage");
const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
mock.restore();

const defaultStoreActions = {
  copyAgentProfile: useAppStore.getState().copyAgentProfile,
  deleteAgentProfile: useAppStore.getState().deleteAgentProfile,
  refreshAgentProfilesCatalog: useAppStore.getState().refreshAgentProfilesCatalog,
  refreshSkillsCatalog: useAppStore.getState().refreshSkillsCatalog,
  requestWorkspaceMcpServers: useAppStore.getState().requestWorkspaceMcpServers,
  upsertAgentProfile: useAppStore.getState().upsertAgentProfile,
};

function resetSubagentsStore(patch: Partial<ReturnType<typeof useAppStore.getState>> = {}) {
  useAppStore.setState((state) => ({
    ...state,
    ready: true,
    selectedWorkspaceId: null,
    workspaceRuntimeById: {},
    workspaces: [],
    ...defaultStoreActions,
    ...patch,
  }));
}

function workspaceRecord(id: string, name: string, workspaceKind: "project" | "oneOffChat") {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    workspaceKind,
    createdAt: "2026-06-02T00:00:00.000Z",
    lastOpenedAt: "2026-06-02T00:00:00.000Z",
    defaultProvider: "google",
    defaultModel: "gemini-3-flash-preview",
    defaultPreferredChildModel: "gemini-3-flash-preview",
    defaultChildModelRoutingMode: "same-provider" as const,
    defaultPreferredChildModelRef: "google:gemini-3-flash-preview",
    defaultAllowedChildModelRefs: [],
    defaultEnableMcp: true,
    defaultBackupsEnabled: true,
    yolo: false,
  };
}

function catalogEntry(scope: AgentProfileScope, id: string, displayName: string) {
  const { scope: _scope, ...profile } = draftProfile();
  return {
    scope,
    path: `/profiles/${id}.json`,
    effective: true,
    shadowed: false,
    profile: {
      ...profile,
      id,
      displayName,
      description: "",
      prompt: "Review regressions carefully.",
    },
  } satisfies AgentProfileCatalogEntry;
}

function profilesCatalog(entries: AgentProfileCatalogEntry[]) {
  return {
    profiles: entries,
    effectiveProfiles: entries.filter((entry) => entry.effective),
    diagnostics: [],
    roots: {
      globalDir: "/tmp/global",
      workspaceDir: "/tmp/workspace",
    },
  };
}

async function renderSubagentsPage() {
  const harness = setupJsdom();
  const container = harness.dom.window.document.getElementById("root");
  if (!container) throw new Error("missing root");
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SubagentsPage));
    await flushUi();
  });
  return { harness, container, root };
}

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function draftProfile() {
  return {
    version: 1 as const,
    scope: "workspace" as const,
    id: "qa-reviewer",
    displayName: "QA Reviewer",
    description: "  trims description  ",
    enabled: true,
    baseRole: "reviewer" as const,
    prompt: "  Review regressions carefully.  ",
    allowedBuiltInTools: ["read", "grep"],
    allowedMcpServers: [],
    skillNames: [],
  };
}

describe("subagents settings page", () => {
  test("reports failed saves without discarding the draft", async () => {
    const upsertAgentProfile = mock(async () => false);

    const result = await saveAgentProfileDraft(draftProfile(), upsertAgentProfile);

    expect(result).toBe("failed");
    expect(upsertAgentProfile).toHaveBeenCalledWith({
      version: 1,
      scope: "workspace",
      id: "qa-reviewer",
      displayName: "QA Reviewer",
      description: "trims description",
      enabled: true,
      baseRole: "reviewer",
      prompt: "Review regressions carefully.",
      allowedBuiltInTools: ["read", "grep"],
      allowedMcpServers: [],
      skillNames: [],
      model: undefined,
      reasoningEffort: undefined,
      defaultTaskType: undefined,
      defaultContextMode: undefined,
    });
  });

  test("strips hidden built-in tools outside the selected base role before saving", async () => {
    const upsertAgentProfile = mock(async () => true);
    const draft = {
      ...draftProfile(),
      baseRole: "reviewer" as const,
      allowedBuiltInTools: ["read", "write", "grep", "webSearch"],
    };

    const result = await saveAgentProfileDraft(draft, upsertAgentProfile);

    expect(result).toBe("saved");
    expect(upsertAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRole: "reviewer",
        allowedBuiltInTools: ["read", "grep"],
      }),
    );
  });

  test("keeps existing profile identity immutable while editing", async () => {
    let root: ReturnType<typeof createRoot> | null = null;
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);
      const draft = {
        ...draftProfile(),
        originalRef: {
          scope: "workspace" as const,
          id: "qa-reviewer",
        },
      };

      await act(async () => {
        root.render(
          createElement(ProfileDialog, {
            draft,
            setDraft: mock(() => {}),
            idTouched: true,
            setIdTouched: mock(() => {}),
            mcpServerNames: [],
            skillNames: [],
            onSave: mock(() => {}),
          }),
        );
        await flushUi();
      });

      const profileIdInput = [...harness.dom.window.document.querySelectorAll("input")].find(
        (input) => input.value === "qa-reviewer",
      );
      if (!(profileIdInput instanceof harness.dom.window.HTMLInputElement)) {
        throw new Error(
          `missing profile id input: ${harness.dom.window.document.body.textContent ?? ""}`,
        );
      }
      const scopeSelect = harness.dom.window.document.querySelector('[role="combobox"]');
      if (!(scopeSelect instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing scope select");
      }

      expect(harness.dom.window.document.body.textContent).toContain("Edit subagent");
      expect(profileIdInput.disabled).toBe(true);
      expect(scopeSelect.disabled).toBe(true);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("prefers project workspace profiles when a one-off chat is selected", async () => {
    const project = workspaceRecord("project-1", "Project", "project");
    const chat = workspaceRecord("chat-1", "Chat", "oneOffChat");
    const refreshAgentProfilesCatalog = mock(async () => {});
    const requestWorkspaceMcpServers = mock(async () => {});
    const refreshSkillsCatalog = mock(async () => {});

    resetSubagentsStore({
      refreshAgentProfilesCatalog,
      refreshSkillsCatalog,
      requestWorkspaceMcpServers,
      selectedWorkspaceId: "chat-1",
      workspaces: [chat, project],
      workspaceRuntimeById: {
        "chat-1": {
          ...defaultWorkspaceRuntime(),
          agentProfilesCatalog: profilesCatalog([
            catalogEntry("workspace", "chat-reviewer", "Chat Reviewer"),
          ]),
        },
        "project-1": {
          ...defaultWorkspaceRuntime(),
          agentProfilesCatalog: profilesCatalog([
            catalogEntry("workspace", "project-reviewer", "Project Reviewer"),
          ]),
        },
      },
    });

    expect(resolveSubagentProfilesWorkspace([chat, project], "chat-1")?.id).toBe("project-1");

    const { harness, container, root } = await renderSubagentsPage();
    try {
      expect(refreshAgentProfilesCatalog).toHaveBeenCalledWith("project-1");
      expect(requestWorkspaceMcpServers).toHaveBeenCalledWith("project-1");
      expect(refreshSkillsCatalog).toHaveBeenCalledWith("project-1");
      expect(container.textContent).toContain("Project Reviewer");
      expect(container.textContent).not.toContain("Chat Reviewer");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("shows a loading state while profiles are refreshing", async () => {
    const project = workspaceRecord("project-1", "Project", "project");
    resetSubagentsStore({
      refreshAgentProfilesCatalog: mock(async () => {}),
      refreshSkillsCatalog: mock(async () => {}),
      requestWorkspaceMcpServers: mock(async () => {}),
      selectedWorkspaceId: "project-1",
      workspaces: [project],
      workspaceRuntimeById: {
        "project-1": {
          ...defaultWorkspaceRuntime(),
          agentProfilesCatalog: null,
          agentProfilesLoading: true,
        },
      },
    });

    const { harness, container, root } = await renderSubagentsPage();
    try {
      expect(container.textContent).toContain("Loading profiles");
      expect(container.textContent).not.toContain("No workspace profiles");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("switches to the copied profile destination scope", async () => {
    const project = workspaceRecord("project-1", "Project", "project");
    const copyAgentProfile = mock(async () => true);
    resetSubagentsStore({
      copyAgentProfile,
      refreshAgentProfilesCatalog: mock(async () => {}),
      refreshSkillsCatalog: mock(async () => {}),
      requestWorkspaceMcpServers: mock(async () => {}),
      selectedWorkspaceId: "project-1",
      workspaces: [project],
      workspaceRuntimeById: {
        "project-1": {
          ...defaultWorkspaceRuntime(),
          agentProfilesCatalog: profilesCatalog([
            catalogEntry("workspace", "workspace-reviewer", "Workspace Reviewer"),
            catalogEntry("global", "global-reviewer", "Global Reviewer"),
          ]),
        },
      },
    });

    const { harness, container, root } = await renderSubagentsPage();
    try {
      expect(container.textContent).toContain("Workspace Reviewer");
      expect(container.textContent).not.toContain("Global Reviewer");

      const copyButton = container.querySelector('[aria-label="Copy profile"]');
      if (!(copyButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing copy profile button");
      }

      await act(async () => {
        copyButton.click();
        await flushUi();
      });

      expect(copyAgentProfile).toHaveBeenCalledWith(
        {
          sourceRef: "workspace:workspace-reviewer",
          targetScope: "global",
        },
        "project-1",
      );
      expect(container.textContent).toContain("Global Reviewer");
      expect(container.textContent).not.toContain("Workspace Reviewer");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });
});
