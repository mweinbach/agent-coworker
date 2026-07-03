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

const {
  buildProfileModelGroups,
  ProfileDialog,
  SubagentsPage,
  listSubagentProfileWorkspaces,
  profileIdFromName,
  profileModelSupportsReasoning,
  providerCatalogForSubagentWorkspace,
  resolveSubagentProfilesWorkspace,
  saveAgentProfileDraft,
} = await import("../src/ui/settings/pages/SubagentsPage");
const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
mock.restore();

const defaultStoreActions = {
  copyAgentProfile: useAppStore.getState().copyAgentProfile,
  deleteAgentProfile: useAppStore.getState().deleteAgentProfile,
  refreshAgentProfilesCatalog: useAppStore.getState().refreshAgentProfilesCatalog,
  refreshProviderStatus: useAppStore.getState().refreshProviderStatus,
  refreshSkillsCatalog: useAppStore.getState().refreshSkillsCatalog,
  requestWorkspaceMcpServers: useAppStore.getState().requestWorkspaceMcpServers,
  upsertAgentProfile: useAppStore.getState().upsertAgentProfile,
};

const ONE_OFF_CHAT_GLOBAL_NOTE =
  "One-off chats can only use global profiles. Choose Global if this subagent should be available there.";

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

function providerCatalogEntry(
  provider: "google" | "openai" | "bedrock",
  modelId: string,
  displayName: string,
) {
  return {
    id: provider,
    name: provider === "openai" ? "OpenAI" : provider === "bedrock" ? "Amazon Bedrock" : "Google",
    defaultModel: modelId,
    models: [
      {
        id: modelId,
        displayName,
        knowledgeCutoff: "unknown",
        supportsImageInput: true,
      },
    ],
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

  test("keeps valid built-in tools outside the selected base role before saving", async () => {
    const upsertAgentProfile = mock(async () => true);
    const draft = {
      ...draftProfile(),
      baseRole: "reviewer" as const,
      allowedBuiltInTools: ["read", "write", "grep", "webSearch", "unknownTool"],
    };

    const result = await saveAgentProfileDraft(draft, upsertAgentProfile);

    expect(result).toBe("saved");
    expect(upsertAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRole: "reviewer",
        allowedBuiltInTools: ["read", "write", "grep", "webSearch"],
      }),
    );
  });

  test("clears unsupported reasoning while preserving hidden task and context defaults", async () => {
    const upsertAgentProfile = mock(async () => true);
    const draft = {
      ...draftProfile(),
      model: "google:gemini-3-flash-preview",
      reasoningEffort: "high" as const,
      defaultTaskType: "verify" as const,
      defaultContextMode: "brief" as const,
    };

    const result = await saveAgentProfileDraft(draft, upsertAgentProfile);

    expect(result).toBe("saved");
    expect(upsertAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "google:gemini-3-flash-preview",
        reasoningEffort: undefined,
        defaultTaskType: "verify",
        defaultContextMode: "brief",
      }),
    );
  });

  test("keeps reasoning for explicit OpenAI-compatible profile model targets", async () => {
    const upsertAgentProfile = mock(async () => true);
    const draft = {
      ...draftProfile(),
      model: "openai:gpt-5.4",
      reasoningEffort: "high" as const,
    };

    const result = await saveAgentProfileDraft(draft, upsertAgentProfile);

    expect(result).toBe("saved");
    expect(upsertAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai:gpt-5.4",
        reasoningEffort: "high",
      }),
    );
  });

  test("keeps locked profiles enabled before saving", async () => {
    const upsertAgentProfile = mock(async () => true);
    const draft = {
      ...draftProfile(),
      id: "default",
      displayName: "Main Agent",
      enabled: false,
      locked: true,
      baseRole: "default" as const,
      allowedBuiltInTools: ["read", "write"],
    };

    const result = await saveAgentProfileDraft(draft, upsertAgentProfile);

    expect(result).toBe("saved");
    expect(upsertAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "default",
        enabled: true,
        baseRole: "default",
      }),
    );
  });

  test("generates profile ids from profile names before saving", async () => {
    const upsertAgentProfile = mock(async () => true);
    const draft = {
      ...draftProfile(),
      id: "",
      displayName: "QA Reviewer 2!",
    };

    const result = await saveAgentProfileDraft(draft, upsertAgentProfile);

    expect(profileIdFromName("QA Reviewer 2!")).toBe("qa-reviewer-2");
    expect(profileIdFromName("Model_IO.Review")).toBe("model-io-review");
    expect(result).toBe("saved");
    expect(upsertAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "qa-reviewer-2",
        displayName: "QA Reviewer 2!",
      }),
    );
  });

  test("shows existing profile identity as generated metadata while editing", async () => {
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
            mcpServerNames: [],
            skillNames: [],
            onSave: mock(() => {}),
          }),
        );
        await flushUi();
      });

      const scopeSelect = harness.dom.window.document.querySelector('[role="combobox"]');
      if (!(scopeSelect instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing scope select");
      }
      const text = harness.dom.window.document.body.textContent ?? "";

      expect(text).toContain("Edit subagent");
      expect(text).toContain("Subagent id");
      expect(text).toContain("workspace:qa-reviewer");
      expect(text).not.toContain("Profile id");
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

  test("shows the profile prompt as the editable prompt value", async () => {
    let root: ReturnType<typeof createRoot> | null = null;
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(ProfileDialog, {
            draft: {
              ...draftProfile(),
              baseRole: "explorer",
              prompt: "Explorer default role prompt.",
            },
            setDraft: mock(() => {}),
            mcpServerNames: [],
            skillNames: [],
            workspace: null,
            workspaceChoices: [],
            onWorkspaceChange: mock(() => {}),
            onSave: mock(() => {}),
          }),
        );
        await flushUi();
      });

      const promptTextarea = harness.dom.window.document.querySelector("textarea");
      if (!(promptTextarea instanceof harness.dom.window.HTMLTextAreaElement)) {
        throw new Error("missing prompt textarea");
      }
      const dialogContent = harness.dom.window.document.querySelector(
        '[data-slot="dialog-content"]',
      );
      if (!(dialogContent instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing profile dialog content");
      }
      expect(promptTextarea.value).toBe("Explorer default role prompt.");
      expect(dialogContent.className).toContain("max-h-[94vh]");
      expect(dialogContent.className).toContain("w-[min(94vw,58rem)]");
      expect(dialogContent.className).toContain("max-w-none");
      expect(dialogContent.className).toContain("sm:max-w-none");
      expect(harness.dom.window.document.body.textContent ?? "").toContain(
        "Default role prompt is editable.",
      );
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("shows every built-in tool in the profile editor", async () => {
    let root: ReturnType<typeof createRoot> | null = null;
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(ProfileDialog, {
            draft: {
              ...draftProfile(),
              baseRole: "reviewer",
              allowedBuiltInTools: ["read", "grep"],
            },
            setDraft: mock(() => {}),
            mcpServerNames: [],
            skillNames: [],
            workspace: null,
            workspaceChoices: [],
            onWorkspaceChange: mock(() => {}),
            onSave: mock(() => {}),
          }),
        );
        await flushUi();
      });

      const text = harness.dom.window.document.body.textContent ?? "";
      expect(text).toContain("Built-in tools");
      expect(text).toContain("write");
      expect(text).toContain("webSearch");
      expect(text).toContain("todoWrite");
      expect(text).not.toContain("Task type");
      expect(text).not.toContain("Context default");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("shows reasoning only for model targets that support it", async () => {
    let root: ReturnType<typeof createRoot> | null = null;
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(ProfileDialog, {
            draft: {
              ...draftProfile(),
              model: "google:gemini-3-flash-preview",
              reasoningEffort: "high",
            },
            setDraft: mock(() => {}),
            mcpServerNames: [],
            skillNames: [],
            providerCatalog: [],
            workspace: null,
            workspaceChoices: [],
            onWorkspaceChange: mock(() => {}),
            onSave: mock(() => {}),
          }),
        );
        await flushUi();
      });

      expect(harness.dom.window.document.body.textContent ?? "").not.toContain("Reasoning");

      await act(async () => {
        root?.render(
          createElement(ProfileDialog, {
            draft: {
              ...draftProfile(),
              model: "openai:gpt-5.4",
              reasoningEffort: "high",
            },
            setDraft: mock(() => {}),
            mcpServerNames: [],
            skillNames: [],
            providerCatalog: [],
            workspace: null,
            workspaceChoices: [],
            onWorkspaceChange: mock(() => {}),
            onSave: mock(() => {}),
          }),
        );
        await flushUi();
      });

      expect(harness.dom.window.document.body.textContent ?? "").toContain("Reasoning");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("builds model picker groups from the provider catalog", () => {
    const result = buildProfileModelGroups(
      [
        {
          id: "openai",
          name: "OpenAI",
          defaultModel: "gpt-5.4",
          models: [
            {
              id: "gpt-5.4",
              displayName: "GPT 5.4",
              knowledgeCutoff: "unknown",
              supportsImageInput: true,
            },
          ],
        },
      ],
      "openai:gpt-5.4",
    );

    expect(profileModelSupportsReasoning("openai:gpt-5.4")).toBe(true);
    expect(profileModelSupportsReasoning("google:gemini-3-flash-preview")).toBe(false);
    expect(result.groups).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        options: [
          {
            value: "openai:gpt-5.4",
            label: "GPT 5.4",
          },
        ],
      }),
    );
  });

  test("profile model picker hides unconfigured provider catalogs", () => {
    const result = buildProfileModelGroups(
      [
        providerCatalogEntry("google", "gemini-3.5-flash", "Gemini 3.5 Flash"),
        providerCatalogEntry("bedrock", "amazon.nova-lite-v1:0", "Amazon Nova Lite"),
      ],
      undefined,
      { includedProviders: ["google"] },
    );

    expect(result.groups.map((group) => group.provider)).toEqual(["google"]);
    expect(JSON.stringify(result)).not.toContain("Amazon Nova Lite");
  });

  test("profile model picker preserves the current unconfigured model as custom", () => {
    const result = buildProfileModelGroups(
      [
        providerCatalogEntry("google", "gemini-3.5-flash", "Gemini 3.5 Flash"),
        providerCatalogEntry("bedrock", "amazon.nova-lite-v1:0", "Amazon Nova Lite"),
      ],
      "bedrock:amazon.nova-lite-v1:0",
      { includedProviders: ["google"] },
    );

    const bedrockGroup = result.groups.find((group) => group.provider === "bedrock");
    expect(bedrockGroup?.options).toEqual([
      {
        value: "bedrock:amazon.nova-lite-v1:0",
        label: "Amazon Nova Lite (custom)",
      },
    ]);
  });

  test("profile model picker does not preserve Antigravity on Windows", () => {
    const harness = setupJsdom();
    try {
      harness.dom.window.document.documentElement.dataset.platform = "win32";
      const result = buildProfileModelGroups(
        [providerCatalogEntry("google", "gemini-3.5-flash", "Gemini 3.5 Flash")],
        "antigravity:gemini-3.1-pro-preview",
      );

      expect(JSON.stringify(result)).not.toContain("antigravity");
      expect(JSON.stringify(result)).not.toContain("Antigravity");
    } finally {
      harness.restore();
    }
  });

  test("uses the selected profile workspace provider catalog for model choices", async () => {
    const project = workspaceRecord("project-1", "Project", "project");
    const refreshProviderStatus = mock(async () => {});
    const runtimeProviderCatalog = [providerCatalogEntry("openai", "gpt-runtime", "GPT Runtime")];
    resetSubagentsStore({
      providerCatalog: [providerCatalogEntry("google", "gemini-stale", "Gemini Stale")],
      refreshAgentProfilesCatalog: mock(async () => {}),
      refreshProviderStatus,
      refreshSkillsCatalog: mock(async () => {}),
      requestWorkspaceMcpServers: mock(async () => {}),
      selectedWorkspaceId: "project-1",
      workspaces: [project],
      workspaceRuntimeById: {
        "project-1": {
          ...defaultWorkspaceRuntime(),
          agentProfilesCatalog: profilesCatalog([]),
          providerCatalog: runtimeProviderCatalog,
        },
      },
    });

    const { harness, root } = await renderSubagentsPage();
    try {
      expect(refreshProviderStatus).toHaveBeenCalledWith({ workspaceId: "project-1" });

      const selectedRuntime = useAppStore.getState().workspaceRuntimeById["project-1"] ?? null;
      const result = buildProfileModelGroups(
        providerCatalogForSubagentWorkspace(selectedRuntime),
        "openai:gpt-runtime",
      );
      expect(result.groups).toContainEqual(
        expect.objectContaining({
          provider: "openai",
          options: [
            {
              value: "openai:gpt-runtime",
              label: "GPT Runtime",
            },
          ],
        }),
      );
      expect(JSON.stringify(result)).not.toContain("Gemini Stale");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("shows built-in profiles in the global scope", async () => {
    const project = workspaceRecord("project-1", "Project", "project");
    const builtInDefault = catalogEntry("global", "default", "Main Agent");
    const { path: _path, ...builtInDefaultEntry } = builtInDefault;
    resetSubagentsStore({
      refreshAgentProfilesCatalog: mock(async () => {}),
      refreshSkillsCatalog: mock(async () => {}),
      requestWorkspaceMcpServers: mock(async () => {}),
      selectedWorkspaceId: "project-1",
      workspaces: [project],
      workspaceRuntimeById: {
        "project-1": {
          ...defaultWorkspaceRuntime(),
          agentProfilesCatalog: profilesCatalog([
            {
              ...builtInDefaultEntry,
              builtIn: true,
              locked: true,
              profile: {
                ...builtInDefault.profile,
                baseRole: "default",
                enabled: true,
              },
            },
          ]),
        },
      },
    });

    const { harness, container, root } = await renderSubagentsPage();
    try {
      // Global is the default scope, so built-in profiles are visible immediately.
      expect(container.textContent).toContain("Main Agent");

      const workspaceTab = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Workspace",
      );
      if (!(workspaceTab instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing workspace scope tab");
      }

      await act(async () => {
        workspaceTab.click();
        await flushUi();
      });

      expect(container.textContent).not.toContain("Main Agent");

      const globalTab = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Global",
      );
      if (!(globalTab instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing global scope tab");
      }

      await act(async () => {
        globalTab.click();
        await flushUi();
      });

      expect(container.textContent).toContain("Main Agent");
      expect(container.textContent).toContain("Built-in");
      expect(container.textContent).toContain("Main");
      const deleteButton = container.querySelector('[aria-label="Delete profile"]');
      if (!(deleteButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing delete profile button");
      }
      expect(deleteButton.disabled).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
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
    expect(listSubagentProfileWorkspaces([chat, project]).map((workspace) => workspace.id)).toEqual(
      ["project-1"],
    );

    const { harness, container, root } = await renderSubagentsPage();
    try {
      expect(refreshAgentProfilesCatalog).toHaveBeenCalledWith("project-1");
      expect(requestWorkspaceMcpServers).toHaveBeenCalledWith("project-1");
      expect(refreshSkillsCatalog).toHaveBeenCalledWith("project-1");

      const workspaceTab = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Workspace",
      );
      if (!(workspaceTab instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing workspace scope tab");
      }
      await act(async () => {
        workspaceTab.click();
        await flushUi();
      });

      expect(container.textContent).toContain("Workspace");
      expect(container.textContent).toContain("One-off chats always use global subagents");
      expect(container.textContent).toContain("Project");
      expect(container.textContent).toContain("/tmp/project-1");
      expect(container.textContent).toContain("Project Reviewer");
      expect(container.textContent).not.toContain("Chat Reviewer");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("honors the explicit subagent profile workspace target", async () => {
    const first = workspaceRecord("project-1", "Project One", "project");
    const second = workspaceRecord("project-2", "Project Two", "project");

    expect(resolveSubagentProfilesWorkspace([first, second], "project-1", "project-2")?.id).toBe(
      "project-2",
    );
  });

  test("shows workspace details without duplicating them in the picker trigger", async () => {
    let root: ReturnType<typeof createRoot> | null = null;
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);
      const first = workspaceRecord("project-1", "Project One", "project");
      const second = workspaceRecord("project-2", "Project Two", "project");

      await act(async () => {
        root.render(
          createElement(ProfileDialog, {
            draft: draftProfile(),
            setDraft: mock(() => {}),
            mcpServerNames: [],
            skillNames: [],
            workspace: first,
            workspaceChoices: [first, second],
            onWorkspaceChange: mock(() => {}),
            onSave: mock(() => {}),
          }),
        );
        await flushUi();
      });

      const text = harness.dom.window.document.body.textContent ?? "";
      expect(text).toContain("Profile workspace");
      expect(text).toContain("Project One");
      expect(text).toContain("/tmp/project-1");
      // The select trigger renders the active workspace name (not a static
      // "Change workspace" label), but the file path stays on the left only.
      expect(text.match(/\/tmp\/project-1/g)?.length ?? 0).toBe(1);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("puts the scope choice before identity fields in the profile dialog", async () => {
    let root: ReturnType<typeof createRoot> | null = null;
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);
      const project = workspaceRecord("project-1", "Project", "project");

      await act(async () => {
        root.render(
          createElement(ProfileDialog, {
            draft: draftProfile(),
            setDraft: mock(() => {}),
            mcpServerNames: [],
            skillNames: [],
            workspace: project,
            workspaceChoices: [project],
            onWorkspaceChange: mock(() => {}),
            onSave: mock(() => {}),
          }),
        );
        await flushUi();
      });

      const text = harness.dom.window.document.body.textContent ?? "";
      expect(text).toContain(ONE_OFF_CHAT_GLOBAL_NOTE);
      expect(text).toContain("Template");
      expect(text).not.toContain("Base role");
      expect(text).not.toContain("Display name");
      expect(text.indexOf("Scope")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("Scope")).toBeLessThan(text.indexOf("Name"));
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
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
      expect(container.textContent).toContain("Loading subagents");
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
      const workspaceTab = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Workspace",
      );
      if (!(workspaceTab instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing workspace scope tab");
      }
      await act(async () => {
        workspaceTab.click();
        await flushUi();
      });

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
