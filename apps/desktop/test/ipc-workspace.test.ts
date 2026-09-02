import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox";
import type { DesktopIpcModuleContext } from "../electron/ipc/types";
import { WorkspaceRootsController } from "../electron/ipc/workspaceRoots";
import { assertWorkspaceDirectory } from "../electron/services/validation";
import type { PersistedState, ThreadRecord } from "../src/app/types";
import { DESKTOP_EVENT_CHANNELS, DESKTOP_IPC_CHANNELS } from "../src/lib/desktopApi";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

let selectedWorkspacePath: string | null = null;

const electronMockOverrides = {
  BrowserWindow: {
    fromWebContents() {
      return null;
    },
    getFocusedWindow() {
      return null;
    },
  },
  dialog: {
    async showOpenDialog() {
      return {
        canceled: selectedWorkspacePath === null,
        filePaths: selectedWorkspacePath === null ? [] : [selectedWorkspacePath],
      };
    },
  },
};

setElectronMockOverrides(electronMockOverrides);

mock.module("electron", () => createElectronMock());

const { registerWorkspaceIpc: registerWorkspaceIpcModule } = await import(
  "../electron/ipc/workspace"
);

function registerWorkspaceIpc(context: DesktopIpcModuleContext): void {
  // The older tests supply minimal storage stubs. Give them the same serial
  // update contract as PersistenceService; real-service atomicity is covered
  // in persistence-state-sanitization.test.ts.
  const persistence = context.deps.persistence as typeof context.deps.persistence & {
    updateState?: (
      update: (state: PersistedState) => PersistedState | Promise<PersistedState>,
      onCommitted?: (state: PersistedState) => void | Promise<void>,
    ) => Promise<PersistedState>;
  };
  if (persistence && !persistence.updateState && persistence.loadState && persistence.saveState) {
    let pending = Promise.resolve();
    persistence.updateState = (update, onCommitted) => {
      const operation = pending.then(async () => {
        const committed = await update(await persistence.loadState());
        await persistence.saveState(committed);
        await onCommitted?.(committed);
        return committed;
      });
      pending = operation.then(
        () => {},
        () => {},
      );
      return operation;
    };
  }
  registerWorkspaceIpcModule(context);
}

describe("workspace IPC", () => {
  beforeEach(() => {
    selectedWorkspacePath = null;
    setElectronMockOverrides(electronMockOverrides);
  });

  test("a delayed state read cannot reapply consent or roots after a newer save", async () => {
    const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>();
    const initial: PersistedState = {
      version: 2,
      workspaces: [{ id: "old", path: "/tmp/old-workspace" } as never],
      threads: [],
      privacyTelemetrySettings: { crashReportsEnabled: true },
    };
    let persisted = structuredClone(initial);
    let activeConsent = true;
    let approvedRoots = ["/tmp/old-workspace"];
    let releaseRefresh!: () => void;
    const refreshMayFinish = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    registerWorkspaceIpc({
      deps: {
        persistence: {
          async loadState() {
            return structuredClone(persisted);
          },
          async saveState(state: PersistedState) {
            persisted = structuredClone(state);
          },
        },
        async applyPersistedState(state: PersistedState) {
          activeConsent = state.privacyTelemetrySettings?.crashReportsEnabled === true;
        },
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState(state) {
          await refreshMayFinish;
          approvedRoots = state.workspaces.map((workspace) => workspace.path);
        },
        async assertApprovedWorkspacePath(value) {
          return value;
        },
        async addApprovedWorkspacePath(value) {
          return value;
        },
        setApprovedWorkspaceRoots(roots) {
          approvedRoots = [...roots];
        },
        getApprovedWorkspaceRoots() {
          return approvedRoots;
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });
    const load = handlers.get(DESKTOP_IPC_CHANNELS.loadState);
    const save = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
    if (!load || !save) throw new Error("Missing state handlers");
    const oldRead = load({});
    await Promise.resolve();
    await save(
      {},
      {
        ...initial,
        workspaces: [{ id: "new", path: "/tmp/new-workspace" }],
        privacyTelemetrySettings: { crashReportsEnabled: false },
      },
    );
    releaseRefresh();
    await oldRead;

    expect(activeConsent).toBe(false);
    expect(approvedRoots).toEqual(["/tmp/new-workspace"]);
  });

  test("the workspace picker preserves saved roots without a preceding renderer load", async () => {
    const temporaryPath = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "cowork-picker-roots-"),
    );
    const root = await fs.realpath(temporaryPath);
    const existingProject = path.join(root, "existing");
    const selectedProject = path.join(root, "selected");
    await fs.mkdir(existingProject);
    await fs.mkdir(selectedProject);
    try {
      const persistence = {
        async loadState() {
          return {
            version: 2,
            workspaces: [{ id: "existing", path: existingProject }],
            threads: [],
          };
        },
      };
      const workspaceRoots = new WorkspaceRootsController(persistence as never);
      const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>();
      selectedWorkspacePath = selectedProject;
      registerWorkspaceIpc({
        deps: { persistence } as never,
        workspaceRoots,
        handleDesktopInvoke(channel, handler) {
          handlers.set(channel, handler as never);
        },
        parseWithSchema(_schema, value) {
          return value as never;
        },
      });
      expect(
        await handlers.get(DESKTOP_IPC_CHANNELS.pickWorkspaceDirectory)?.({ sender: {} }),
      ).toBe(selectedProject);

      await expect(workspaceRoots.assertApprovedWorkspacePath(existingProject)).resolves.toBe(
        existingProject,
      );
      await expect(workspaceRoots.assertApprovedWorkspacePath(selectedProject)).resolves.toBe(
        selectedProject,
      );
    } finally {
      await fs.rm(temporaryPath, { recursive: true, force: true });
    }
  });

  test.each(["main", "popup"] as const)(
    "preserves concurrently saved popup threads and %s window changes",
    async (secondWindow) => {
      const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>();
      const timestamp = "2026-09-01T00:00:00.000Z";
      const base: PersistedState = {
        version: 2,
        workspaces: [
          {
            id: "ws",
            name: "Workspace",
            path: "/tmp/workspace",
            createdAt: timestamp,
            lastOpenedAt: timestamp,
            defaultEnableMcp: true,
            yolo: false,
          },
        ],
        threads: [],
      };
      const thread: ThreadRecord = {
        id: "popup-one",
        workspaceId: "ws",
        title: "Popup thread",
        createdAt: timestamp,
        lastMessageAt: timestamp,
        status: "active",
        sessionId: null,
        messageCount: 1,
        lastEventSeq: 1,
      };
      let persisted = structuredClone(base);
      registerWorkspaceIpc({
        deps: {
          persistence: {
            async loadState() {
              return structuredClone(persisted);
            },
            async saveState(state: PersistedState) {
              persisted = structuredClone(state);
            },
          },
        } as never,
        workspaceRoots: {
          async ensureApprovedWorkspaceRoots() {},
          async refreshApprovedWorkspaceRootsFromState() {},
          async assertApprovedWorkspacePath(value) {
            return value;
          },
          async addApprovedWorkspacePath(value) {
            return value;
          },
          setApprovedWorkspaceRoots() {},
          getApprovedWorkspaceRoots() {
            return ["/tmp/workspace"];
          },
        },
        handleDesktopInvoke(channel, handler) {
          handlers.set(channel, handler as never);
        },
        parseWithSchema(_schema, value) {
          return value as never;
        },
      });
      const save = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
      if (!save) throw new Error("Missing saveState handler");
      const popupEvent = {
        sender: { getURL: () => "file:///renderer/index.html?window=quick-chat" },
      };

      await Promise.all([
        save(popupEvent, { ...base, threads: [thread] }),
        save(secondWindow === "main" ? {} : popupEvent, {
          ...base,
          threads: secondWindow === "main" ? [] : [{ ...thread, id: "popup-two" }],
          developerMode: true,
        }),
      ]);

      expect(persisted.threads.map((item) => item.id)).toEqual(
        secondWindow === "main" ? ["popup-one"] : ["popup-one", "popup-two"],
      );
      if (secondWindow === "main") expect(persisted.developerMode).toBe(true);
    },
  );

  test("failed main-window saves do not consume popup thread protection", async () => {
    const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>();
    const timestamp = "2026-09-01T00:00:00.000Z";
    const initial: PersistedState = {
      version: 2,
      workspaces: [{ id: "ws", path: "/tmp/workspace" } as never],
      threads: [],
    };
    let persisted = structuredClone(initial);
    let failNextWrite = false;
    registerWorkspaceIpc({
      deps: {
        persistence: {
          async loadState() {
            return structuredClone(persisted);
          },
          async saveState(state: PersistedState) {
            if (failNextWrite) {
              failNextWrite = false;
              throw new Error("Disk is full");
            }
            persisted = structuredClone(state);
          },
        },
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(value) {
          return value;
        },
        async addApprovedWorkspacePath(value) {
          return value;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return ["/tmp/workspace"];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });
    const save = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
    if (!save) throw new Error("Missing saveState handler");
    await save(
      { sender: { getURL: () => "file:///renderer/index.html?window=quick-chat" } },
      {
        ...initial,
        threads: [
          {
            id: "popup",
            workspaceId: "ws",
            lastEventSeq: 1,
            messageCount: 1,
            lastMessageAt: timestamp,
          },
        ],
      },
    );
    failNextWrite = true;
    await expect(save({}, persisted)).rejects.toThrow("Disk is full");
    await save({}, initial);

    expect(persisted.threads.map((thread) => thread.id)).toEqual(["popup"]);
  });

  test("startWorkspaceServer returns only renderer-safe connection details", async () => {
    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    let managerStartOptions: unknown;
    let managerStatusWorkspaceId: string | null = null;
    const sentEvents: Array<{ channel: string; payload: unknown }> = [];

    registerWorkspaceIpc({
      deps: {
        mobileRelayBridge: { isActiveForWorkspace: () => true },
        persistence: {},
        serverManager: {
          async startWorkspaceServer(opts: unknown) {
            managerStartOptions = opts;
            (
              opts as {
                onCoworkRuntimeBootstrapProgress?: (progress: Record<string, unknown>) => void;
              }
            ).onCoworkRuntimeBootstrapProgress?.({
              phase: "downloading",
              version: "2026-06-22",
              transferredBytes: 25,
              totalBytes: 100,
              percent: 25,
            });
            return {
              url: "ws://127.0.0.1:7337/ws",
              mobileH3: {
                adminToken: "secret-admin-token",
                certSha256: "cert",
                spkiSha256: "spki",
                hostHints: ["127.0.0.1"],
                port: 7338,
              },
            };
          },
          async getWorkspaceServerStatus(workspaceId: string) {
            managerStatusWorkspaceId = workspaceId;
            return {
              workspaceId,
              running: true,
              url: "ws://127.0.0.1:7337/ws",
              reason: "running",
            };
          },
          async stopWorkspaceServer() {},
        },
        updater: {} as never,
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const startServerHandler = handlers.get(DESKTOP_IPC_CHANNELS.startWorkspaceServer);
    expect(startServerHandler).toBeDefined();

    const result = await startServerHandler?.(
      {
        sender: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => sentEvents.push({ channel, payload }),
        },
      },
      {
        workspaceId: "ws-1",
        workspacePath: "/tmp/ws-1",
        yolo: false,
        forceRestart: true,
        preserveMobileRelay: true,
        privacyTelemetrySettings: {
          aiTraceTelemetryEnabled: true,
          aiTracePayloadsEnabled: false,
        },
      },
    );

    expect(result).toEqual({ url: "ws://127.0.0.1:7337/ws" });
    expect(managerStartOptions).toMatchObject({
      workspaceId: "ws-1",
      workspacePath: "/tmp/ws-1",
      yolo: false,
      forceRestart: true,
      mobileH3: true,
      privacyTelemetrySettings: {
        aiTraceTelemetryEnabled: true,
        aiTracePayloadsEnabled: false,
      },
    });
    expect(sentEvents).toEqual([
      {
        channel: DESKTOP_EVENT_CHANNELS.workspaceServerStartupProgress,
        payload: {
          workspaceId: "ws-1",
          progress: {
            phase: "downloading",
            version: "2026-06-22",
            transferredBytes: 25,
            totalBytes: 100,
            percent: 25,
          },
        },
      },
    ]);

    const statusHandler = handlers.get(DESKTOP_IPC_CHANNELS.getWorkspaceServerStatus);
    expect(statusHandler).toBeDefined();
    await expect(statusHandler?.({}, { workspaceId: "ws-1" })).resolves.toEqual({
      workspaceId: "ws-1",
      running: true,
      url: "ws://127.0.0.1:7337/ws",
      reason: "running",
    });
    expect(managerStatusWorkspaceId).toBe("ws-1");
  });

  test("updates approved roots after saving workspace state", async () => {
    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    const callOrder: string[] = [];
    let approvedRoots: string[] = [];

    registerWorkspaceIpc({
      deps: {
        mobileRelayBridge: { isActiveForWorkspace: () => false },
        persistence: {
          async saveState() {
            callOrder.push("saveState");
          },
          async loadState() {
            return { workspaces: [] };
          },
          async readTranscript() {
            return [];
          },
          async appendTranscriptEvent() {},
          async appendTranscriptBatch() {},
          async deleteTranscript() {},
        },
        serverManager: {
          async startWorkspaceServer() {
            return { workspaceId: "ws", url: "ws://127.0.0.1:7337/ws" };
          },
          async stopWorkspaceServer() {},
        },
        updater: {} as never,
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots(paths: Iterable<string>) {
          approvedRoots = [...paths];
          callOrder.push("setApprovedWorkspaceRoots");
        },
        getApprovedWorkspaceRoots() {
          return approvedRoots;
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const saveStateHandler = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
    expect(saveStateHandler).toBeDefined();

    await saveStateHandler?.(
      {},
      {
        activeWorkspaceId: null,
        activeThreadId: null,
        workspaces: [
          {
            id: "ws-1",
            title: "Workspace One",
            path: "/tmp/ws-1",
            threadIds: [],
          },
        ],
        threadIndex: {},
        expandedSkillSectionByWorkspaceId: {},
        providersByWorkspaceId: {},
        providerSettingsByWorkspaceId: {},
        workspaceMcpConfigByWorkspaceId: {},
        inputByThreadId: {},
        modeByThreadId: {},
        profileByThreadId: {},
      },
    );

    expect(callOrder).toEqual(["saveState", "setApprovedWorkspaceRoots"]);
    expect(approvedRoots).toEqual(["/tmp/ws-1"]);
  });

  test("saves trusted offline projects and starts them again after their drive is reconnected", async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "cowork-ipc-offline-project-"),
    );
    const projectPath = path.join(await fs.realpath(temporaryDirectory), "external-project");
    const detachedPath = path.join(await fs.realpath(temporaryDirectory), "detached-project");
    await fs.mkdir(projectPath);

    try {
      const handlers = new Map<
        string,
        (event: unknown, args?: unknown) => Promise<unknown> | unknown
      >();
      let persistedState = {
        version: 2,
        workspaces: [
          {
            id: "ws-external",
            name: "External project",
            path: projectPath,
            workspaceKind: "project" as const,
            createdAt: "2026-08-24T00:00:00.000Z",
            lastOpenedAt: "2026-08-24T00:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            yolo: false,
          },
        ],
        threads: [
          {
            id: "thread-external",
            workspaceId: "ws-external",
            title: "Preserved conversation",
            createdAt: "2026-08-24T00:00:00.000Z",
            lastMessageAt: "2026-08-24T00:00:00.000Z",
            status: "disconnected" as const,
            sessionId: "session-external",
            messageCount: 4,
            lastEventSeq: 7,
          },
        ],
        developerMode: false,
      };
      const persistence = {
        async loadState() {
          return persistedState;
        },
        async saveState(next: typeof persistedState) {
          persistedState = next;
        },
      };
      const workspaceRoots = new WorkspaceRootsController(persistence as never);

      registerWorkspaceIpc({
        deps: {
          mobileRelayBridge: { isActiveForWorkspace: () => false },
          persistence,
          serverManager: {
            async startWorkspaceServer(input: { workspacePath: string }) {
              await assertWorkspaceDirectory(input.workspacePath);
              return { url: "ws://127.0.0.1:7337/ws" };
            },
            async stopWorkspaceServer() {},
          },
          updater: {} as never,
        } as never,
        workspaceRoots,
        handleDesktopInvoke(channel, handler) {
          handlers.set(channel, handler as never);
        },
        parseWithSchema(_schema, value) {
          return value as never;
        },
      });

      const loadState = handlers.get(DESKTOP_IPC_CHANNELS.loadState);
      const saveState = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
      const startServer = handlers.get(DESKTOP_IPC_CHANNELS.startWorkspaceServer);
      if (!loadState || !saveState || !startServer) {
        throw new Error("workspace IPC handlers were not registered");
      }

      await loadState({});
      await fs.rename(projectPath, detachedPath);

      await expect(
        saveState({}, { ...persistedState, developerMode: true }),
      ).resolves.toBeUndefined();
      expect(persistedState.developerMode).toBe(true);
      expect(persistedState.workspaces[0]?.path).toBe(projectPath);
      expect(persistedState.threads[0]?.title).toBe("Preserved conversation");

      await loadState({});
      const sender = { sender: { isDestroyed: () => false, send: () => {} } };
      const serverInput = { workspaceId: "ws-external", workspacePath: projectPath };
      await expect(startServer(sender, serverInput)).rejects.toThrow(
        "Reconnect its drive or restore access",
      );

      await fs.rename(detachedPath, projectPath);

      await expect(startServer(sender, serverInput)).resolves.toEqual({
        url: "ws://127.0.0.1:7337/ws",
      });
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("popup saveState preserves newer persisted data and merges popup threads", async () => {
    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    let savedState: any = null;

    registerWorkspaceIpc({
      deps: {
        mobileRelayBridge: { isActiveForWorkspace: () => false },
        persistence: {
          async saveState(state: unknown) {
            savedState = state;
          },
          async loadState() {
            return {
              version: 2,
              workspaces: [
                {
                  id: "ws-main",
                  name: "Main workspace",
                  path: "/tmp/ws-main",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  lastOpenedAt: "2026-04-21T10:00:00.000Z",
                  defaultEnableMcp: true,
                  defaultBackupsEnabled: true,
                  yolo: false,
                },
                {
                  id: "ws-newer",
                  name: "Newer workspace",
                  path: "/tmp/ws-newer",
                  createdAt: "2026-04-21T09:00:00.000Z",
                  lastOpenedAt: "2026-04-21T11:00:00.000Z",
                  defaultEnableMcp: true,
                  defaultBackupsEnabled: true,
                  yolo: false,
                },
              ],
              threads: [
                {
                  id: "thread-main",
                  workspaceId: "ws-main",
                  title: "Latest main thread",
                  titleSource: "manual",
                  createdAt: "2026-04-21T09:00:00.000Z",
                  lastMessageAt: "2026-04-21T11:00:00.000Z",
                  status: "active",
                  sessionId: "session-main",
                  messageCount: 4,
                  lastEventSeq: 4,
                },
                {
                  id: "thread-newer",
                  workspaceId: "ws-newer",
                  title: "Newer thread",
                  titleSource: "manual",
                  createdAt: "2026-04-21T10:30:00.000Z",
                  lastMessageAt: "2026-04-21T11:30:00.000Z",
                  status: "active",
                  sessionId: "session-newer",
                  messageCount: 2,
                  lastEventSeq: 2,
                },
              ],
              developerMode: true,
              showHiddenFiles: true,
            };
          },
          async readTranscript() {
            return [];
          },
          async appendTranscriptEvent() {},
          async appendTranscriptBatch() {},
          async deleteTranscript() {},
        },
        serverManager: {
          async startWorkspaceServer() {
            return { workspaceId: "ws", url: "ws://127.0.0.1:7337/ws" };
          },
          async stopWorkspaceServer() {},
        },
        updater: {} as never,
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const saveStateHandler = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
    expect(saveStateHandler).toBeDefined();

    await saveStateHandler?.(
      {
        sender: {
          getURL: () => "file:///renderer/index.html?window=quick-chat",
        },
      },
      {
        version: 2,
        workspaces: [
          {
            id: "ws-main",
            name: "Stale popup workspace",
            path: "/tmp/ws-main",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-04-21T08:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: true,
            yolo: false,
          },
        ],
        threads: [
          {
            id: "thread-main",
            workspaceId: "ws-main",
            title: "Stale popup thread",
            titleSource: "manual",
            createdAt: "2026-04-21T09:00:00.000Z",
            lastMessageAt: "2026-04-21T10:00:00.000Z",
            status: "active",
            sessionId: "session-main",
            messageCount: 3,
            lastEventSeq: 3,
          },
          {
            id: "thread-popup",
            workspaceId: "ws-main",
            title: "Popup draft",
            titleSource: "manual",
            createdAt: "2026-04-21T11:45:00.000Z",
            lastMessageAt: "2026-04-21T11:45:00.000Z",
            status: "active",
            sessionId: "session-popup",
            messageCount: 0,
            lastEventSeq: 0,
          },
        ],
        developerMode: false,
        showHiddenFiles: false,
      },
    );

    expect(savedState.workspaces.map((workspace: any) => workspace.id)).toEqual([
      "ws-main",
      "ws-newer",
    ]);
    expect(savedState.threads.map((thread: any) => thread.id)).toEqual([
      "thread-main",
      "thread-newer",
      "thread-popup",
    ]);
    expect(savedState.threads[0]?.title).toBe("Latest main thread");
    expect(savedState.developerMode).toBe(true);
    expect(savedState.showHiddenFiles).toBe(true);
  });

  test("main saveState preserves popup threads and deduplicates incoming ids in first-seen order", async () => {
    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    let persistedState: any = {
      version: 2,
      workspaces: [
        {
          id: "ws-main",
          name: "Main workspace",
          path: "/tmp/ws-main",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-04-21T10:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-main",
          workspaceId: "ws-main",
          title: "Main thread",
          titleSource: "manual",
          createdAt: "2026-04-21T09:00:00.000Z",
          lastMessageAt: "2026-04-21T11:00:00.000Z",
          status: "active",
          sessionId: "session-main",
          messageCount: 4,
          lastEventSeq: 4,
        },
      ],
      developerMode: false,
      showHiddenFiles: false,
    };

    registerWorkspaceIpc({
      deps: {
        mobileRelayBridge: { isActiveForWorkspace: () => false },
        persistence: {
          async saveState(state: unknown) {
            persistedState = state;
          },
          async loadState() {
            return persistedState;
          },
          async readTranscript() {
            return [];
          },
          async appendTranscriptEvent() {},
          async appendTranscriptBatch() {},
          async deleteTranscript() {},
        },
        serverManager: {
          async startWorkspaceServer() {
            return { workspaceId: "ws", url: "ws://127.0.0.1:7337/ws" };
          },
          async stopWorkspaceServer() {},
        },
        updater: {} as never,
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const saveStateHandler = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
    expect(saveStateHandler).toBeDefined();

    await saveStateHandler?.(
      {
        sender: {
          getURL: () => "file:///renderer/index.html?window=quick-chat",
        },
      },
      {
        ...persistedState,
        threads: [
          ...persistedState.threads,
          {
            id: "thread-popup",
            workspaceId: "ws-main",
            title: "Popup thread",
            titleSource: "manual",
            createdAt: "2026-04-21T11:45:00.000Z",
            lastMessageAt: "2026-04-21T11:45:00.000Z",
            status: "active",
            sessionId: "session-popup",
            messageCount: 1,
            lastEventSeq: 1,
          },
        ],
      },
    );

    const mainThread = persistedState.threads[0];
    const secondThread = { ...mainThread, id: "thread-second", title: "Second thread" };
    await saveStateHandler?.(
      {},
      {
        ...persistedState,
        threads: [secondThread, mainThread, { ...secondThread, title: "Latest second thread" }],
        developerMode: true,
      },
    );

    expect(persistedState.threads.map((thread: { id: string }) => thread.id)).toEqual([
      "thread-second",
      "thread-main",
      "thread-popup",
    ]);
    expect(persistedState.threads[0].title).toBe("Latest second thread");
    expect(persistedState.developerMode).toBe(true);
  });

  test("main saveState preserves metadata-only thread edits", async () => {
    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    let persistedState: any = {
      version: 2,
      workspaces: [
        {
          id: "ws-main",
          name: "Main workspace",
          path: "/tmp/ws-main",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-04-21T10:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-main",
          workspaceId: "ws-main",
          title: "Old title",
          titleSource: "model",
          createdAt: "2026-04-21T09:00:00.000Z",
          lastMessageAt: "2026-04-21T11:00:00.000Z",
          status: "active",
          sessionId: "session-main",
          messageCount: 4,
          lastEventSeq: 4,
        },
      ],
    };

    registerWorkspaceIpc({
      deps: {
        mobileRelayBridge: { isActiveForWorkspace: () => false },
        persistence: {
          async saveState(state: unknown) {
            persistedState = state;
          },
          async loadState() {
            return persistedState;
          },
          async readTranscript() {
            return [];
          },
          async appendTranscriptEvent() {},
          async appendTranscriptBatch() {},
          async deleteTranscript() {},
        },
        serverManager: {
          async startWorkspaceServer() {
            return { workspaceId: "ws", url: "ws://127.0.0.1:7337/ws" };
          },
          async stopWorkspaceServer() {},
        },
        updater: {} as never,
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    await handlers.get(DESKTOP_IPC_CHANNELS.saveState)?.(
      {},
      {
        ...persistedState,
        threads: [
          {
            ...persistedState.threads[0],
            title: "Renamed title",
            titleSource: "manual",
          },
        ],
      },
    );

    expect(persistedState.threads[0]?.title).toBe("Renamed title");
    expect(persistedState.threads[0]?.titleSource).toBe("manual");
  });

  test("main saveState can delete popup threads after observing loaded state", async () => {
    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    let persistedState: any = {
      version: 2,
      workspaces: [
        {
          id: "ws-main",
          name: "Main workspace",
          path: "/tmp/ws-main",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-04-21T10:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-main",
          workspaceId: "ws-main",
          title: "Main thread",
          titleSource: "manual",
          createdAt: "2026-04-21T09:00:00.000Z",
          lastMessageAt: "2026-04-21T11:00:00.000Z",
          status: "active",
          sessionId: "session-main",
          messageCount: 4,
          lastEventSeq: 4,
        },
      ],
    };

    registerWorkspaceIpc({
      deps: {
        mobileRelayBridge: { isActiveForWorkspace: () => false },
        persistence: {
          async saveState(state: unknown) {
            persistedState = state;
          },
          async loadState() {
            return persistedState;
          },
          async readTranscript() {
            return [];
          },
          async appendTranscriptEvent() {},
          async appendTranscriptBatch() {},
          async deleteTranscript() {},
        },
        serverManager: {
          async startWorkspaceServer() {
            return { workspaceId: "ws", url: "ws://127.0.0.1:7337/ws" };
          },
          async stopWorkspaceServer() {},
        },
        updater: {} as never,
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    await handlers.get(DESKTOP_IPC_CHANNELS.saveState)?.(
      {
        sender: {
          getURL: () => "file:///renderer/index.html?window=quick-chat",
        },
      },
      {
        ...persistedState,
        threads: [
          ...persistedState.threads,
          {
            id: "thread-popup",
            workspaceId: "ws-main",
            title: "Popup thread",
            titleSource: "manual",
            createdAt: "2026-04-21T11:45:00.000Z",
            lastMessageAt: "2026-04-21T11:45:00.000Z",
            status: "active",
            sessionId: "session-popup",
            messageCount: 1,
            lastEventSeq: 1,
          },
        ],
      },
    );

    await handlers.get(DESKTOP_IPC_CHANNELS.loadState)?.({
      sender: {
        getURL: () => "file:///renderer/index.html",
      },
    });

    await handlers.get(DESKTOP_IPC_CHANNELS.saveState)?.(
      {},
      {
        ...persistedState,
        threads: persistedState.threads.filter(
          (thread: { id: string }) => thread.id === "thread-main",
        ),
      },
    );

    expect(persistedState.threads.map((thread: { id: string }) => thread.id)).toEqual([
      "thread-main",
    ]);
  });

  test("popup saveState does not resurrect thread ids removed by the main window", async () => {
    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    let savedState: any = null;
    let persistedState: any = {
      version: 2,
      workspaces: [
        {
          id: "ws-main",
          name: "Main workspace",
          path: "/tmp/ws-main",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-04-21T10:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-main",
          workspaceId: "ws-main",
          title: "Latest main thread",
          titleSource: "manual",
          createdAt: "2026-04-21T09:00:00.000Z",
          lastMessageAt: "2026-04-21T11:00:00.000Z",
          status: "active",
          sessionId: "session-main",
          messageCount: 4,
          lastEventSeq: 4,
        },
        {
          id: "thread-deleted",
          workspaceId: "ws-main",
          title: "Deleted thread",
          titleSource: "manual",
          createdAt: "2026-04-21T08:45:00.000Z",
          lastMessageAt: "2026-04-21T09:15:00.000Z",
          status: "active",
          sessionId: "session-deleted",
          messageCount: 1,
          lastEventSeq: 1,
        },
      ],
    };

    registerWorkspaceIpc({
      deps: {
        mobileRelayBridge: { isActiveForWorkspace: () => false },
        persistence: {
          async saveState(state: unknown) {
            savedState = state;
            persistedState = state;
          },
          async loadState() {
            return persistedState;
          },
          async readTranscript() {
            return [];
          },
          async appendTranscriptEvent() {},
          async appendTranscriptBatch() {},
          async deleteTranscript() {},
        },
        serverManager: {
          async startWorkspaceServer() {
            return { workspaceId: "ws", url: "ws://127.0.0.1:7337/ws" };
          },
          async stopWorkspaceServer() {},
        },
        updater: {} as never,
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const saveStateHandler = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
    expect(saveStateHandler).toBeDefined();

    await saveStateHandler?.(
      {},
      {
        ...persistedState,
        threads: [persistedState.threads[0]],
      },
    );

    await saveStateHandler?.(
      {
        sender: {
          getURL: () => "file:///renderer/index.html?window=quick-chat",
        },
      },
      {
        version: 2,
        workspaces: [
          {
            id: "ws-main",
            name: "Main workspace",
            path: "/tmp/ws-main",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-04-21T08:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: true,
            yolo: false,
          },
        ],
        threads: [
          {
            id: "thread-main",
            workspaceId: "ws-main",
            title: "Latest main thread",
            titleSource: "manual",
            createdAt: "2026-04-21T09:00:00.000Z",
            lastMessageAt: "2026-04-21T11:00:00.000Z",
            status: "active",
            sessionId: "session-main",
            messageCount: 4,
            lastEventSeq: 4,
          },
          {
            id: "thread-deleted",
            workspaceId: "ws-main",
            title: "Deleted thread",
            titleSource: "manual",
            createdAt: "2026-04-21T08:45:00.000Z",
            lastMessageAt: "2026-04-21T09:15:00.000Z",
            status: "active",
            sessionId: "session-deleted",
            messageCount: 1,
            lastEventSeq: 1,
          },
        ],
      },
    );

    expect(savedState.threads.map((thread: { id: string }) => thread.id)).toEqual(["thread-main"]);
  });

  test("popup saveState does not re-add workspaces removed by the main window", async () => {
    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    let savedState: any = null;

    registerWorkspaceIpc({
      deps: {
        mobileRelayBridge: { isActiveForWorkspace: () => false },
        persistence: {
          async saveState(state: unknown) {
            savedState = state;
          },
          async loadState() {
            return {
              version: 2,
              workspaces: [
                {
                  id: "ws-main",
                  name: "Main workspace",
                  path: "/tmp/ws-main",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  lastOpenedAt: "2026-04-21T10:00:00.000Z",
                  defaultEnableMcp: true,
                  defaultBackupsEnabled: true,
                  yolo: false,
                },
              ],
              threads: [
                {
                  id: "thread-main",
                  workspaceId: "ws-main",
                  title: "Latest main thread",
                  titleSource: "manual",
                  createdAt: "2026-04-21T09:00:00.000Z",
                  lastMessageAt: "2026-04-21T11:00:00.000Z",
                  status: "active",
                  sessionId: "session-main",
                  messageCount: 4,
                  lastEventSeq: 4,
                },
              ],
            };
          },
          async readTranscript() {
            return [];
          },
          async appendTranscriptEvent() {},
          async appendTranscriptBatch() {},
          async deleteTranscript() {},
        },
        serverManager: {
          async startWorkspaceServer() {
            return { workspaceId: "ws", url: "ws://127.0.0.1:7337/ws" };
          },
          async stopWorkspaceServer() {},
        },
        updater: {} as never,
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const saveStateHandler = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
    expect(saveStateHandler).toBeDefined();

    await saveStateHandler?.(
      {
        sender: {
          getURL: () => "file:///renderer/index.html?window=quick-chat",
        },
      },
      {
        version: 2,
        workspaces: [
          {
            id: "ws-main",
            name: "Main workspace",
            path: "/tmp/ws-main",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-04-21T08:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: true,
            yolo: false,
          },
          {
            id: "ws-deleted",
            name: "Deleted workspace",
            path: "/tmp/ws-deleted",
            createdAt: "2026-01-02T00:00:00.000Z",
            lastOpenedAt: "2026-04-21T08:30:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: true,
            yolo: false,
          },
        ],
        threads: [
          {
            id: "thread-main",
            workspaceId: "ws-main",
            title: "Latest main thread",
            titleSource: "manual",
            createdAt: "2026-04-21T09:00:00.000Z",
            lastMessageAt: "2026-04-21T11:00:00.000Z",
            status: "active",
            sessionId: "session-main",
            messageCount: 4,
            lastEventSeq: 4,
          },
          {
            id: "thread-deleted",
            workspaceId: "ws-deleted",
            title: "Deleted workspace thread",
            titleSource: "manual",
            createdAt: "2026-04-21T08:45:00.000Z",
            lastMessageAt: "2026-04-21T09:15:00.000Z",
            status: "active",
            sessionId: "session-deleted",
            messageCount: 1,
            lastEventSeq: 1,
          },
        ],
      },
    );

    expect(savedState.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([
      "ws-main",
    ]);
    expect(savedState.threads.map((thread: { id: string }) => thread.id)).toEqual(["thread-main"]);
  });

  test("popup saveState ignores stale removed workspace paths instead of rejecting", async () => {
    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    let savedState: any = null;

    registerWorkspaceIpc({
      deps: {
        mobileRelayBridge: { isActiveForWorkspace: () => false },
        persistence: {
          async saveState(state: unknown) {
            savedState = state;
          },
          async loadState() {
            return {
              version: 2,
              workspaces: [
                {
                  id: "ws-main",
                  name: "Main workspace",
                  path: "/tmp/ws-main",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  lastOpenedAt: "2026-04-21T10:00:00.000Z",
                  defaultEnableMcp: true,
                  defaultBackupsEnabled: true,
                  yolo: false,
                },
              ],
              threads: [],
            };
          },
          async readTranscript() {
            return [];
          },
          async appendTranscriptEvent() {},
          async appendTranscriptBatch() {},
          async deleteTranscript() {},
        },
        serverManager: {
          async startWorkspaceServer() {
            return { workspaceId: "ws", url: "ws://127.0.0.1:7337/ws" };
          },
          async stopWorkspaceServer() {},
        },
        updater: {} as never,
      } as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          if (workspacePath === "/tmp/ws-deleted") {
            throw new Error("workspace no longer approved");
          }
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const saveStateHandler = handlers.get(DESKTOP_IPC_CHANNELS.saveState);
    expect(saveStateHandler).toBeDefined();

    await expect(
      saveStateHandler?.(
        {
          sender: {
            getURL: () => "file:///renderer/index.html?window=quick-chat",
          },
        },
        {
          version: 2,
          workspaces: [
            {
              id: "ws-main",
              name: "Main workspace",
              path: "/tmp/ws-main",
              createdAt: "2026-01-01T00:00:00.000Z",
              lastOpenedAt: "2026-04-21T08:00:00.000Z",
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              yolo: false,
            },
            {
              id: "ws-deleted",
              name: "Deleted workspace",
              path: "/tmp/ws-deleted",
              createdAt: "2026-01-02T00:00:00.000Z",
              lastOpenedAt: "2026-04-21T08:30:00.000Z",
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              yolo: false,
            },
          ],
          threads: [],
        },
      ),
    ).resolves.toBeUndefined();

    expect(savedState.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([
      "ws-main",
    ]);
  });
});
