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

const { ProfileDialog, saveAgentProfileDraft } = await import(
  "../src/ui/settings/pages/SubagentsPage"
);
mock.restore();

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
});
