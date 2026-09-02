import { describe, expect, mock, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
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

const {
  CHATS_MEMORY_TARGET_ID,
  MEMORY_LOADING_STALL_MS,
  MemoryPage,
  buildMemoryGenerationModelGroups,
  isMemoryLoadStalled,
  parentDirectoryPath,
  resolveDraftMemoryId,
  resolveMemoryGenerationModelSelection,
  resolveMemoryTargets,
} = await import("../src/ui/settings/pages/MemoryPage");
const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const { operationKey } = await import("../src/app/store.helpers/operations");

function buttonWithText(scope: ParentNode, label: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function changeField(document: Document, id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!input) throw new Error(`Missing field: ${id}`);
  input.value = value;
  // React loads before jsdom in the Bun preload. Invoke the rendered field's
  // change handler, matching the other settings-page tests.
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`Missing React props: ${id}`);
  const props = (input as unknown as Record<string, unknown>)[propsKey] as {
    onChange: (event: { target: typeof input; currentTarget: typeof input }) => void;
  };
  props.onChange({ target: input, currentTarget: input });
}

describe("desktop memory page", () => {
  test("blank ids resolve to the prompt-loaded hot cache entry", () => {
    expect(resolveDraftMemoryId("")).toBe("hot");
    expect(resolveDraftMemoryId("   ")).toBe("hot");
    expect(resolveDraftMemoryId(" AGENT.md ")).toBe("AGENT.md");
    expect(resolveDraftMemoryId("people/sarah")).toBe("people/sarah");
  });

  test("skill status loads once after the selected workspace is ready, not on bootstrap object changes", async () => {
    const previousState = useAppStore.getState();
    const harness = setupJsdom();
    const root = createRoot(harness.dom.window.document.getElementById("root")!);
    const selectedId = "memory-waiting";
    const otherId = "memory-ready";
    const status = mock(async () => {});
    const workspace = (id: string) => ({
      id,
      name: id,
      path: `/tmp/${id}`,
      createdAt: "2026-08-27T00:00:00.000Z",
      lastOpenedAt: "2026-08-27T00:00:00.000Z",
      defaultEnableMcp: true,
      defaultBackupsEnabled: false,
      defaultAdvancedMemory: false,
      yolo: false,
    });
    try {
      useAppStore.setState({
        workspaces: [workspace(selectedId), workspace(otherId)],
        selectedWorkspaceId: selectedId,
        requestWorkspaceMemories: mock(async () => {}),
        requestSkillImprovementStatus: status,
        workspaceRuntimeById: {
          [selectedId]: defaultWorkspaceRuntime(),
          [otherId]: { ...defaultWorkspaceRuntime(), controlSessionId: "other-control" },
        },
      });
      await act(async () =>
        root.render(createElement(StrictMode, null, createElement(MemoryPage))),
      );
      expect(status).not.toHaveBeenCalled();

      await act(async () => {
        useAppStore.setState((state) => ({
          workspaceRuntimeById: {
            ...state.workspaceRuntimeById,
            [selectedId]: {
              ...state.workspaceRuntimeById[selectedId],
              controlSessionId: `jsonrpc:${selectedId}`,
            },
          },
        }));
      });
      expect(status.mock.calls).toEqual([[selectedId, { cwd: `/tmp/${selectedId}` }]]);

      await act(async () => {
        useAppStore.setState((state) => ({
          workspaces: state.workspaces.map((entry) => ({ ...entry, defaultEnableMcp: false })),
          workspaceRuntimeById: {
            ...state.workspaceRuntimeById,
            [selectedId]: {
              ...state.workspaceRuntimeById[selectedId],
              controlSessionId: "hydrated-control",
            },
          },
        }));
      });
      expect(status).toHaveBeenCalledTimes(1);
      await act(async () => useAppStore.setState({ selectedWorkspaceId: otherId }));
      expect(status.mock.calls).toEqual([
        [selectedId, { cwd: `/tmp/${selectedId}` }],
        [otherId, { cwd: `/tmp/${otherId}` }],
      ]);
    } finally {
      await act(async () => root.unmount());
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("Add preserves a collision draft and Edit explicitly updates the existing memory", async () => {
    const previousState = useAppStore.getState();
    const harness = setupJsdom();
    const document = harness.dom.window.document;
    const root = createRoot(document.getElementById("root")!);
    const workspaceId = "memory-create-workspace";
    const cwd = "/tmp/memory-create-workspace";
    const key = operationKey("memory", "save", workspaceId);
    const collision = {
      code: "request_failed" as const,
      message: 'Memory "hot" already exists. Edit it or use a different title.',
      retryable: true,
      repairAction: "Check the connection and retry.",
    };
    let firstSave = true;
    const save = mock<typeof previousState.upsertWorkspaceMemory>(async () => {
      if (firstSave) {
        firstSave = false;
        useAppStore.setState({
          operationsByKey: {
            [key]: {
              status: "error",
              key,
              label: "Save memory",
              startedAt: "2026-08-27T00:00:00.000Z",
              finishedAt: "2026-08-27T00:00:01.000Z",
              error: collision,
            },
          },
        });
        return { ok: false, error: collision };
      }
      useAppStore.setState({ operationsByKey: {} });
      return { ok: true, value: undefined };
    });

    try {
      useAppStore.setState({
        workspaces: [
          {
            id: workspaceId,
            name: "Memory workspace",
            path: cwd,
            createdAt: "2026-08-27T00:00:00.000Z",
            lastOpenedAt: "2026-08-27T00:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            defaultAdvancedMemory: false,
            yolo: false,
          },
        ],
        selectedWorkspaceId: workspaceId,
        operationsByKey: {},
        requestWorkspaceMemories: mock(async () => {}),
        requestSkillImprovementStatus: mock(async () => {}),
        upsertWorkspaceMemory: save,
        workspaceRuntimeById: {
          [workspaceId]: {
            ...defaultWorkspaceRuntime(),
            controlSessionId: "memory-control-session",
            memories: [
              {
                id: "hot",
                scope: "workspace",
                content: "Original memory",
                createdAt: "2026-08-27T00:00:00.000Z",
                updatedAt: "2026-08-27T00:00:00.000Z",
              },
            ],
          },
        },
      });
      await act(async () => root.render(createElement(MemoryPage)));
      await act(async () => buttonWithText(document, "Add memory").click());
      await act(async () => changeField(document, "memory-content", "  Keep my new draft  "));
      await act(async () => buttonWithText(document, "Add remembered fact").click());

      expect(save.mock.calls[0]).toEqual([
        workspaceId,
        "workspace",
        "hot",
        "Keep my new draft",
        { cwd, mode: "create" },
      ]);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect((document.getElementById("memory-content") as HTMLTextAreaElement).value).toBe(
        "  Keep my new draft  ",
      );
      const feedback = document.querySelector('[data-operation-feedback="error"]');
      const footer = document.querySelector('[data-slot="dialog-footer"]');
      const formScrollArea = document.getElementById("memory-content")?.closest(".overflow-y-auto");
      expect(Boolean(footer && feedback?.closest('[data-slot="dialog-footer"]') === footer)).toBe(
        true,
      );
      expect(formScrollArea?.contains(feedback)).toBe(false);
      expect(feedback?.querySelector('[data-slot="alert-title"]')?.textContent).toBe(
        "Memory not saved",
      );
      expect(feedback?.textContent).toContain(collision.message);
      expect(feedback?.textContent).not.toContain("Check the connection and retry.");

      await act(async () => buttonWithText(document, "Cancel").click());
      await act(async () => {
        const row = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("Always include"),
        );
        if (!row) throw new Error("Missing existing memory");
        row.click();
      });
      await act(async () => buttonWithText(document, "Edit").click());
      expect((document.getElementById("memory-title") as HTMLInputElement).value).toBe("hot");
      expect((document.getElementById("memory-title") as HTMLInputElement).disabled).toBe(true);
      await act(async () => changeField(document, "memory-content", "Intentional edit"));
      await act(async () => buttonWithText(document, "Save changes").click());
      expect(save.mock.calls[1]).toEqual([
        workspaceId,
        "workspace",
        "hot",
        "Intentional edit",
        { cwd, mode: "upsert" },
      ]);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("stalled empty memory loads fall back to the empty state instead of spinning forever", async () => {
    const previousState = useAppStore.getState();
    useAppStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace-1",
          createdAt: "2026-03-13T00:00:00.000Z",
          lastOpenedAt: "2026-03-13T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
      workspaceRuntimeById: {
        "ws-1": {
          serverUrl: "ws://mock",
          starting: false,
          error: null,
          controlSessionId: "control-session",
          controlConfig: null,
          controlSessionConfig: null,
          controlEnableMcp: true,
          mcpServers: [],
          mcpFiles: [],
          mcpWarnings: [],
          mcpValidationByName: {},
          mcpLastAuthChallenge: null,
          mcpLastAuthResult: null,
          skills: [],
          selectedSkillName: null,
          selectedSkillContent: null,
          memories: [],
          memoriesLoading: true,
          workspaceBackupsPath: null,
          workspaceBackups: [],
          workspaceBackupsLoading: false,
          workspaceBackupsError: null,
          workspaceBackupPendingActionKeys: {},
          workspaceBackupDelta: null,
          workspaceBackupDeltaLoading: false,
          workspaceBackupDeltaError: null,
        },
      },
      requestWorkspaceMemories: mock(async () => {}),
    });

    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      const stallMs = 1_000;
      await act(async () => {
        root.render(createElement(MemoryPage, { loadingStallMs: stallMs }));
      });

      // Assert the pre-stall loading state right after mount, before the
      // injected stall window can elapse.
      expect(container.textContent).toContain("Loading…");
      expect(container.textContent).not.toContain("No remembered facts yet");

      const skillMaintenanceTitle = Array.from(container.querySelectorAll("div")).find(
        (element) => element.textContent === "Advanced skill maintenance",
      );
      const skillMaintenanceRow = skillMaintenanceTitle?.closest(".settings-row");
      const configureButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Configure"),
      );
      expect(skillMaintenanceRow?.className).toContain("px-4");
      expect(skillMaintenanceRow?.className).toContain("py-3.5");
      expect(configureButton).not.toBeUndefined();

      await act(async () => {
        configureButton?.click();
      });
      expect(container.querySelector('[aria-label="Skill improvement"]')).not.toBeNull();

      const deadline = Date.now() + 5_000;
      while (!container.textContent?.includes("Still loading…") && Date.now() < deadline) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, stallMs));
        });
      }

      expect(container.textContent).toContain("Still loading…");
      expect(container.textContent).not.toContain("No remembered facts yet");
      expect(container.textContent).toContain("Retry");
      expect(container.textContent).not.toContain("Loading…");

      await act(async () => {
        root.unmount();
      });
    } finally {
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("memory loading stall helper only trips after the grace period", () => {
    expect(isMemoryLoadStalled(false, Date.now(), Date.now())).toBe(false);
    expect(isMemoryLoadStalled(true, null, Date.now())).toBe(false);
    expect(isMemoryLoadStalled(true, 1000, 1000 + MEMORY_LOADING_STALL_MS - 1)).toBe(false);
    expect(isMemoryLoadStalled(true, 1000, 1000 + MEMORY_LOADING_STALL_MS)).toBe(true);
  });

  test("memory model choices include provider-qualified models across providers", () => {
    const groups = buildMemoryGenerationModelGroups(
      [
        {
          id: "google",
          name: "Google",
          status: "connected",
          models: [{ id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro" }],
        },
        {
          id: "together",
          name: "Together AI",
          status: "connected",
          models: [{ id: "moonshotai/Kimi-K2.5", displayName: "Kimi K2.5" }],
        },
      ] as any,
      "together:moonshotai/Kimi-K2.5",
    );

    expect(groups.map((group) => group.provider)).toContain("google");
    expect(groups.map((group) => group.provider)).toContain("together");
    expect(groups.flatMap((group) => group.options.map((option) => option.value))).toContain(
      "together:moonshotai/Kimi-K2.5",
    );
    expect(resolveMemoryGenerationModelSelection("moonshotai/Kimi-K2.5", "together")).toBe(
      "together:moonshotai/Kimi-K2.5",
    );
  });

  test("memory model choices hide unconfigured provider catalogs", () => {
    const groups = buildMemoryGenerationModelGroups(
      [
        {
          id: "google",
          name: "Google",
          defaultModel: "gemini-3.5-flash",
          models: [
            {
              id: "gemini-3.5-flash",
              displayName: "Gemini 3.5 Flash",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
            },
          ],
        },
        {
          id: "bedrock",
          name: "Amazon Bedrock",
          defaultModel: "amazon.nova-lite-v1:0",
          models: [
            {
              id: "amazon.nova-lite-v1:0",
              displayName: "Amazon Nova Lite",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
          ],
        },
      ],
      "",
      { includedProviders: ["google"] },
    );

    expect(groups.map((group) => group.provider)).toEqual(["google"]);
    expect(JSON.stringify(groups)).not.toContain("Amazon Nova Lite");
  });

  test("memory model choices include connected Codex models missing from a partial live catalog", () => {
    const groups = buildMemoryGenerationModelGroups(
      [
        {
          id: "google",
          name: "Google",
          defaultModel: "gemini-3.5-flash",
          models: [{ id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash" }],
        },
      ] as any,
      "",
      { includedProviders: ["google", "codex-cli"] },
    );

    const codexGroup = groups.find((group) => group.provider === "codex-cli");
    expect(codexGroup?.options.map((option) => option.value)).toContain("codex-cli:gpt-5.6-sol");
  });

  test("memory model choices preserve the current unconfigured model as custom", () => {
    const groups = buildMemoryGenerationModelGroups(
      [
        {
          id: "google",
          name: "Google",
          defaultModel: "gemini-3.5-flash",
          models: [
            {
              id: "gemini-3.5-flash",
              displayName: "Gemini 3.5 Flash",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
            },
          ],
        },
        {
          id: "bedrock",
          name: "Amazon Bedrock",
          defaultModel: "amazon.nova-lite-v1:0",
          models: [
            {
              id: "amazon.nova-lite-v1:0",
              displayName: "Amazon Nova Lite",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
            {
              id: "amazon.nova-micro-v1:0",
              displayName: "Amazon Nova Micro",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
          ],
        },
      ],
      "bedrock:amazon.nova-lite-v1:0",
      { includedProviders: ["google"] },
    );

    const bedrockGroup = groups.find((group) => group.provider === "bedrock");
    expect(bedrockGroup?.options).toEqual([
      {
        value: "bedrock:amazon.nova-lite-v1:0",
        label: "Amazon Nova Lite (custom)",
        title: "amazon.nova-lite-v1:0",
      },
    ]);
    expect(JSON.stringify(groups)).not.toContain("Amazon Nova Micro");
  });

  test("memory model choices do not preserve Antigravity on Windows", () => {
    const harness = setupJsdom();
    try {
      harness.dom.window.document.documentElement.dataset.platform = "win32";
      const groups = buildMemoryGenerationModelGroups(
        [
          {
            id: "google",
            name: "Google",
            defaultModel: "gemini-3.5-flash",
            models: [{ id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash" }],
          },
        ] as any,
        "antigravity:gemini-3.1-pro-preview",
      );

      expect(JSON.stringify(groups)).not.toContain("antigravity");
      expect(JSON.stringify(groups)).not.toContain("Antigravity");
    } finally {
      harness.restore();
    }
  });

  test("memory targets collapse non-project chats while keeping projects individual", () => {
    const chatsRoot = "/tmp/cowork-home/.cowork/chats";
    const workspaces = [
      {
        id: "chat-1",
        name: "New chat",
        path: `${chatsRoot}/20260602-chat-1`,
        workspaceKind: "oneOffChat",
      },
      {
        id: "chat-2",
        name: "New chat",
        path: `${chatsRoot}/20260602-chat-2`,
        workspaceKind: "oneOffChat",
      },
      {
        id: "project-1",
        name: "Cowork",
        path: "/Users/me/Projects/Cowork",
      },
      {
        id: "project-2",
        name: "GoogleIO",
        path: "/Users/me/Projects/GoogleIO",
      },
    ];

    const { targets, activeTarget } = resolveMemoryTargets(workspaces as any, "chat-2");

    expect(targets.map((target) => target.label)).toEqual(["Chats", "Cowork", "GoogleIO"]);
    expect(targets.filter((target) => target.label === "New chat")).toHaveLength(0);
    expect(activeTarget).toEqual({
      id: CHATS_MEMORY_TARGET_ID,
      label: "Chats",
      kind: "chats",
      workspaceId: "chat-2",
      targetPath: chatsRoot,
    });
  });

  test("memory targets use the selected project as an individual target", () => {
    const { activeTarget } = resolveMemoryTargets(
      [
        {
          id: "chat-1",
          name: "New chat",
          path: "/tmp/cowork-home/.cowork/chats/20260602-chat-1",
          workspaceKind: "oneOffChat",
        },
        {
          id: "project-1",
          name: "Cowork",
          path: "/Users/me/Projects/Cowork",
        },
      ] as any,
      "project-1",
    );

    expect(activeTarget).toEqual({
      id: "project-1",
      label: "Cowork",
      kind: "project",
      workspaceId: "project-1",
      targetPath: "/Users/me/Projects/Cowork",
    });
  });

  test("parent directory resolver handles slash styles used by chat paths", () => {
    expect(parentDirectoryPath("/tmp/.cowork/chats/chat-1")).toBe("/tmp/.cowork/chats");
    expect(parentDirectoryPath(String.raw`C:\Users\me\.cowork\chats\chat-1`)).toBe(
      String.raw`C:\Users\me\.cowork\chats`,
    );
  });
});
