import { describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

type JsdomHarness = {
  dom: JSDOM;
  restore: () => void;
};

function setupJsdom(): JsdomHarness {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost",
  });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    actEnv: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return {
    dom,
    restore: () => {
      globalThis.window = saved.window;
      globalThis.document = saved.document;
      globalThis.navigator = saved.navigator;
      globalThis.HTMLElement = saved.HTMLElement;
      globalThis.Node = saved.Node;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.actEnv;
      dom.window.close();
    },
  };
}

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

mock.module("../src/lib/desktopCommands", () => ({
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
}));

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: class {
    connect() {}
    send() {
      return true;
    }
    close() {}
  },
}));

const { BackupPage } = await import("../src/ui/settings/pages/BackupPage");
const { useAppStore } = await import("../src/app/store");

describe("desktop backup page", () => {
  test("renders an empty-state prompt when no workspace is selected", () => {
    const html = renderToStaticMarkup(createElement(BackupPage, { workspace: null, runtime: null }));

    expect(html).toContain("Workspace Backups");
    expect(html).toContain("Select a workspace first to manage its backup history.");
  });

  test("renders workspace rail, backup list, delta pane, and failed backup copy", () => {
    const html = renderToStaticMarkup(
      createElement(BackupPage, {
        workspace: {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace",
          createdAt: "2026-03-10T00:00:00.000Z",
          lastOpenedAt: "2026-03-10T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
        runtime: {
          serverUrl: "ws://mock",
          starting: false,
          error: null,
          controlSessionId: "control-session",
          controlConfig: null,
          controlSessionConfig: null,
          controlEnableMcp: true,
          mcpServers: [],
          mcpLegacy: null,
          mcpFiles: [],
          mcpWarnings: [],
          mcpValidationByName: {},
          mcpLastAuthChallenge: null,
          mcpLastAuthResult: null,
          skills: [],
          selectedSkillName: null,
          selectedSkillContent: null,
          workspaceBackupsPath: "/tmp/workspace",
          workspaceBackupsLoading: false,
          workspaceBackupsError: null,
          workspaceBackupPendingActionKeys: {},
          workspaceBackups: [
            {
              targetSessionId: "session-deleted",
              title: null,
              provider: "openai",
              model: "gpt-5.2",
              lifecycle: "deleted",
              status: "ready",
              workingDirectory: "/tmp/workspace",
              backupDirectory: "/tmp/home/.cowork/session-backups/session-deleted",
              originalSnapshotKind: "directory",
              originalSnapshotBytes: 8192,
              checkpointBytesTotal: 4096,
              totalBytes: 12288,
              checkpoints: [
                {
                  id: "cp-0001",
                  index: 1,
                  createdAt: "2026-03-10T00:01:00.000Z",
                  trigger: "initial",
                  changed: false,
                  patchBytes: 0,
                },
              ],
              createdAt: "2026-03-10T00:00:00.000Z",
              updatedAt: "2026-03-10T00:02:00.000Z",
            },
            {
              targetSessionId: "session-failed",
              title: "Broken backup",
              provider: null,
              model: null,
              lifecycle: "closed",
              status: "failed",
              workingDirectory: "/tmp/workspace",
              backupDirectory: "/tmp/home/.cowork/session-backups/session-failed",
              originalSnapshotKind: "pending",
              originalSnapshotBytes: null,
              checkpointBytesTotal: null,
              totalBytes: null,
              checkpoints: [],
              createdAt: "2026-03-10T00:03:00.000Z",
              updatedAt: "2026-03-10T00:04:00.000Z",
              failureReason: "Invalid backup metadata schema",
            },
          ],
        } as any,
      }),
    );

    expect(html).toContain("Workspace Backups");
    expect(html).toContain("Backup History");
    expect(html).toContain("Session backups");
    expect(html).toContain("Deleted session");
    expect(html).toContain("Broken backup");
    expect(html).toContain("cp-0001");
    expect(html).toContain("Backup Error:</strong> Invalid backup metadata schema");
    expect(html).toContain("Create Checkpoint");
    expect(html).toContain("Restore Original Workspace");
    expect(html).toContain("Delete Backup Entry");
    expect(html).toContain("Reveal Folder");
    expect(html).toContain("No checkpoints");
    expect(html).toContain('data-backup-split="true"');
    expect(html).toContain('data-backup-rail="true"');
    expect(html).toContain('data-backup-detail="true"');
  });

  test("auto-refreshes once when the backup page opens", async () => {
    const { dom, restore } = setupJsdom();
    const previousState = useAppStore.getState();
    let requestCount = 0;

    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace",
          createdAt: "2026-03-10T00:00:00.000Z",
          lastOpenedAt: "2026-03-10T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
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
          mcpLegacy: null,
          mcpFiles: [],
          mcpWarnings: [],
          mcpValidationByName: {},
          mcpLastAuthChallenge: null,
          mcpLastAuthResult: null,
          skills: [],
          selectedSkillName: null,
          selectedSkillContent: null,
          workspaceBackupsPath: "/tmp/workspace",
          workspaceBackupsLoading: false,
          workspaceBackupsError: null,
          workspaceBackupPendingActionKeys: {},
          workspaceBackups: [],
        },
      },
      requestWorkspaceBackups: async (workspaceId: string) => {
        requestCount += 1;
        useAppStore.setState((state) => ({
          workspaceRuntimeById: {
            ...state.workspaceRuntimeById,
            [workspaceId]: {
              ...state.workspaceRuntimeById[workspaceId],
              workspaceBackupsLoading: true,
            },
          },
        }));
      },
    });

    const container = dom.window.document.getElementById("root");
    if (!container) throw new Error("missing test root");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(BackupPage));
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(requestCount).toBe(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      useAppStore.setState(previousState, true);
      restore();
    }
  });

  test("does not auto-request a checkpoint delta when the page opens", async () => {
    const { dom, restore } = setupJsdom();
    const previousState = useAppStore.getState();
    let refreshCount = 0;
    let deltaCount = 0;

    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace",
          createdAt: "2026-03-10T00:00:00.000Z",
          lastOpenedAt: "2026-03-10T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
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
          mcpLegacy: null,
          mcpFiles: [],
          mcpWarnings: [],
          mcpValidationByName: {},
          mcpLastAuthChallenge: null,
          mcpLastAuthResult: null,
          skills: [],
          selectedSkillName: null,
          selectedSkillContent: null,
          workspaceBackupsPath: "/tmp/workspace",
          workspaceBackupsLoading: false,
          workspaceBackupsError: null,
          workspaceBackupPendingActionKeys: {},
          workspaceBackups: [
            {
              targetSessionId: "session-1",
              title: "Session 1",
              provider: "openai",
              model: "gpt-5.2",
              lifecycle: "active",
              status: "ready",
              workingDirectory: "/tmp/workspace",
              backupDirectory: "/tmp/home/.cowork/session-backups/session-1",
              originalSnapshotKind: "directory",
              originalSnapshotBytes: 8192,
              checkpointBytesTotal: 4096,
              totalBytes: 12288,
              checkpoints: [
                {
                  id: "cp-0001",
                  index: 1,
                  createdAt: "2026-03-10T00:01:00.000Z",
                  trigger: "manual",
                  changed: true,
                  patchBytes: 4096,
                },
              ],
              createdAt: "2026-03-10T00:00:00.000Z",
              updatedAt: "2026-03-10T00:02:00.000Z",
            },
          ],
          workspaceBackupDelta: null,
          workspaceBackupDeltaLoading: false,
          workspaceBackupDeltaError: null,
        },
      },
      requestWorkspaceBackups: async () => {
        refreshCount += 1;
      },
      requestWorkspaceBackupDelta: async () => {
        deltaCount += 1;
      },
    });

    const container = dom.window.document.getElementById("root");
    if (!container) throw new Error("missing test root");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(BackupPage));
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(refreshCount).toBe(1);
      expect(deltaCount).toBe(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
      useAppStore.setState(previousState, true);
      restore();
    }
  });

  test("ignores stale delta previews from a different session with the same checkpoint id", async () => {
    const { dom, restore } = setupJsdom();
    const previousState = useAppStore.getState();
    const deltaRequests: Array<{ workspaceId: string; targetSessionId: string; checkpointId: string }> = [];

    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace",
          createdAt: "2026-03-10T00:00:00.000Z",
          lastOpenedAt: "2026-03-10T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [],
      threadRuntimeById: {},
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
          mcpLegacy: null,
          mcpFiles: [],
          mcpWarnings: [],
          mcpValidationByName: {},
          mcpLastAuthChallenge: null,
          mcpLastAuthResult: null,
          skills: [],
          selectedSkillName: null,
          selectedSkillContent: null,
          workspaceBackupsPath: "/tmp/workspace",
          workspaceBackupsLoading: false,
          workspaceBackupsError: null,
          workspaceBackupPendingActionKeys: {},
          workspaceBackups: [
            {
              targetSessionId: "session-1",
              title: "Session 1",
              provider: "openai",
              model: "gpt-5.2",
              lifecycle: "active",
              status: "ready",
              workingDirectory: "/tmp/workspace",
              backupDirectory: "/tmp/home/.cowork/session-backups/session-1",
              originalSnapshotKind: "directory",
              originalSnapshotBytes: 8192,
              checkpointBytesTotal: 4096,
              totalBytes: 12288,
              checkpoints: [
                {
                  id: "cp-0001",
                  index: 1,
                  createdAt: "2026-03-10T00:01:00.000Z",
                  trigger: "manual",
                  changed: true,
                  patchBytes: 4096,
                },
              ],
              createdAt: "2026-03-10T00:00:00.000Z",
              updatedAt: "2026-03-10T00:03:00.000Z",
            },
            {
              targetSessionId: "session-2",
              title: "Session 2",
              provider: "openai",
              model: "gpt-5.2",
              lifecycle: "active",
              status: "ready",
              workingDirectory: "/tmp/workspace",
              backupDirectory: "/tmp/home/.cowork/session-backups/session-2",
              originalSnapshotKind: "directory",
              originalSnapshotBytes: 4096,
              checkpointBytesTotal: 2048,
              totalBytes: 6144,
              checkpoints: [
                {
                  id: "cp-0001",
                  index: 1,
                  createdAt: "2026-03-10T00:02:00.000Z",
                  trigger: "manual",
                  changed: true,
                  patchBytes: 2048,
                },
              ],
              createdAt: "2026-03-10T00:00:30.000Z",
              updatedAt: "2026-03-10T00:02:30.000Z",
            },
          ],
          workspaceBackupDelta: {
            type: "workspace_backup_delta",
            sessionId: "control-session",
            targetSessionId: "session-1",
            checkpointId: "cp-0001",
            baselineLabel: "cp-0000",
            currentLabel: "cp-0001",
            counts: { added: 1, modified: 0, deleted: 0 },
            files: [{ path: "stale.txt", change: "added", kind: "file" }],
            truncated: false,
          },
          workspaceBackupDeltaLoading: true,
          workspaceBackupDeltaError: null,
        },
      },
      requestWorkspaceBackups: async () => {},
      requestWorkspaceBackupDelta: async (workspaceId: string, targetSessionId: string, checkpointId: string) => {
        deltaRequests.push({ workspaceId, targetSessionId, checkpointId });
      },
    });

    const container = dom.window.document.getElementById("root");
    if (!container) throw new Error("missing test root");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(BackupPage));
      });
      await act(async () => {
        await Promise.resolve();
      });

      const checkpointButtons = Array.from(container.querySelectorAll("button"))
        .filter((button) => button.textContent?.includes("cp-0001"));
      expect(checkpointButtons).toHaveLength(2);

      await act(async () => {
        checkpointButtons[1]?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(deltaRequests).toEqual([
        { workspaceId: "ws-1", targetSessionId: "session-2", checkpointId: "cp-0001" },
      ]);
      expect(container.textContent).toContain("Loading file changes...");
      expect(container.textContent).not.toContain("stale.txt");
    } finally {
      await act(async () => {
        root.unmount();
      });
      useAppStore.setState(previousState, true);
      restore();
    }
  });
});
