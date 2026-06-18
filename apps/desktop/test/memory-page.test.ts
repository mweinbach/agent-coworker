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

describe("desktop memory page", () => {
  test("blank ids resolve to the prompt-loaded hot cache entry", () => {
    expect(resolveDraftMemoryId("")).toBe("hot");
    expect(resolveDraftMemoryId("   ")).toBe("hot");
    expect(resolveDraftMemoryId(" AGENT.md ")).toBe("AGENT.md");
    expect(resolveDraftMemoryId("people/sarah")).toBe("people/sarah");
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

      await act(async () => {
        root.render(createElement(MemoryPage));
      });

      expect(container.textContent).toContain("Loading...");
      expect(container.textContent).not.toContain("No remembered facts yet");

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, MEMORY_LOADING_STALL_MS + 100));
      });

      expect(container.textContent).toContain("Still loading…");
      expect(container.textContent).not.toContain("No remembered facts yet");
      expect(container.textContent).toContain("Retry");
      expect(container.textContent).not.toContain("Loading...");

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
