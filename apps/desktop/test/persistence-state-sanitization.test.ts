import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { pinHome } from "../../../test/helpers/platform";
import { createEmptyTaskCreationDraft } from "../src/app/creationDrafts";
import { isStandardChatThread } from "../src/app/threadFilters";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

let userDataDir = "";
let appDataDir = "";
let restoreHome: (() => void) | null = null;
const oneOffTestDirs: string[] = [];

const electronMockOverrides = {
  app: {
    getPath: (name: string) => (name === "appData" ? appDataDir : userDataDir),
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null,
    getFocusedWindow: () => null,
  },
  Menu: {
    buildFromTemplate() {
      return {
        popup() {},
      };
    },
  },
};

setElectronMockOverrides(electronMockOverrides);

mock.module("electron", () => createElectronMock());

const { PersistenceService } = await import("../electron/services/persistence");

const TS = "2024-01-01T00:00:00.000Z";

describe("desktop persistence state validation", () => {
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
  });

  beforeEach(async () => {
    appDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-appdata-"));
    restoreHome = pinHome(appDataDir);
    userDataDir = path.join(appDataDir, "Cowork");
    await fs.mkdir(userDataDir, { recursive: true });
  });

  afterEach(async () => {
    if (!appDataDir) {
      return;
    }
    await fs.rm(appDataDir, { recursive: true, force: true });
    await Promise.all(oneOffTestDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    oneOffTestDirs.length = 0;
    restoreHome?.();
    restoreHome = null;
    userDataDir = "";
    appDataDir = "";
  });

  test("saveState skips invalid workspaces and orphan threads instead of failing", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-valid");
    const invalidWorkspace = path.join(userDataDir, "workspace-file.txt");
    await fs.mkdir(validWorkspace, { recursive: true });
    await fs.writeFile(invalidWorkspace, "A file cannot be used as a workspace.");

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_valid",
          name: "Valid workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultPreferredChildModel: "gpt-5.2-mini",
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
        {
          id: "ws_invalid",
          name: "Invalid workspace",
          path: invalidWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: false,
          yolo: true,
        },
      ],
      threads: [
        {
          id: "thread_valid",
          workspaceId: "ws_valid",
          title: "Valid thread",
          titleSource: "manual",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: null,
          lastEventSeq: 0,
        },
        {
          id: "thread_orphan",
          workspaceId: "ws_invalid",
          title: "Orphan thread",
          titleSource: "manual",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: null,
          lastEventSeq: 0,
        },
      ],
      developerMode: true,
      showHiddenFiles: true,
    });

    const loaded = await persistence.loadState();
    expect(loaded.workspaces).toHaveLength(1);
    expect(loaded.workspaces[0]?.id).toBe("ws_valid");
    expect(loaded.workspaces[0]?.workspaceKind).toBe("project");
    expect(loaded.workspaces[0]?.wsProtocol).toBe("jsonrpc");
    expect(loaded.workspaces[0]?.defaultBackupsEnabled).toBe(false);
    expect(loaded.threads).toHaveLength(1);
    expect(loaded.threads[0]?.id).toBe("thread_valid");
  });

  test("saveState round-trips the workflows experiment override", async () => {
    const persistence = new PersistenceService();

    await persistence.saveState({
      version: 2,
      workspaces: [],
      threads: [],
      desktopFeatureFlagOverrides: { workflows: true },
    });

    const loaded = await persistence.loadState();
    expect(loaded.desktopFeatureFlagOverrides).toEqual({ workflows: true });
  });

  test("saveState round-trips complete composer drafts and drops malformed attachments", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-drafts");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_drafts",
          name: "Draft workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread_drafts",
          workspaceId: "ws_drafts",
          title: "Draft thread",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: "session_drafts",
          messageCount: 1,
          lastEventSeq: 1,
          reasoningEffort: "high",
        },
      ],
      composerDrafts: {
        "thread:thread_drafts": {
          revision: 4,
          generation: 1,
          updatedAt: TS,
          text: "persist me",
          attachments: [
            {
              filename: "notes.txt",
              mimeType: "text/plain",
              size: 5,
              lastModified: 7,
              signature: "notes",
              contentBase64: "bm90ZXM=",
            },
            {
              filename: "broken.txt",
              mimeType: "text/plain",
              size: 50,
              lastModified: 8,
              signature: "broken",
              contentBase64: "dG9vIHNob3J0",
            },
          ],
          references: [{ kind: "skill", name: "documents" }],
          provider: "openai",
          model: "gpt-5.4",
          reasoningEffort: "high",
        },
      },
    });

    const loaded = await persistence.loadState();
    expect(loaded.threads[0]?.reasoningEffort).toBe("high");
    expect(loaded.composerDrafts?.["thread:thread_drafts"]).toEqual({
      revision: 4,
      generation: 1,
      updatedAt: TS,
      text: "persist me",
      attachments: [
        {
          filename: "notes.txt",
          mimeType: "text/plain",
          size: 5,
          lastModified: 7,
          signature: "notes",
          contentBase64: "bm90ZXM=",
        },
      ],
      references: [{ kind: "skill", name: "documents" }],
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
  });

  test("saveState round-trips research and task creation drafts with their retry state", async () => {
    const persistence = new PersistenceService();
    const taskDraft = {
      ...createEmptyTaskCreationDraft(6, "ws_drafts"),
      updatedAt: TS,
      idempotencyKey: "stable-task-creation-key",
      title: "Prepare the launch checklist",
      objective: "Keep my full unsent brief after restarting.",
      workItems: [
        {
          id: "work-item-1",
          key: "step-1",
          title: "Inspect current status",
          description: "Review all open reliability issues.",
          dependencies: "",
          expectedOutputs: "A prioritized checklist",
        },
      ],
    };

    await persistence.saveState({
      version: 2,
      workspaces: [],
      threads: [],
      creationDrafts: {
        research: {
          revision: 4,
          generation: 2,
          updatedAt: TS,
          text: "Compare failure-recovery strategies",
          attachments: [
            {
              filename: "notes.txt",
              mimeType: "text/plain",
              size: 5,
              lastModified: 7,
              signature: "research-notes",
              contentBase64: "bm90ZXM=",
            },
          ],
          references: [{ kind: "skill", name: "documents" }],
          provider: "openai",
          model: "gpt-5.4",
          reasoningEffort: "high",
        },
        researchError: { revision: 4, message: "Research submission can be retried." },
        task: taskDraft,
        taskError: { revision: 6, message: "Task submission can be retried." },
      },
    });

    const loaded = await persistence.loadState();

    expect(loaded.creationDrafts).toEqual({
      research: {
        revision: 4,
        generation: 2,
        updatedAt: TS,
        text: "Compare failure-recovery strategies",
        attachments: [
          {
            filename: "notes.txt",
            mimeType: "text/plain",
            size: 5,
            lastModified: 7,
            signature: "research-notes",
            contentBase64: "bm90ZXM=",
          },
        ],
        references: [{ kind: "skill", name: "documents" }],
        provider: "openai",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
      researchError: { revision: 4, message: "Research submission can be retried." },
      task: taskDraft,
      taskError: { revision: 6, message: "Task submission can be retried." },
    });
  });

  test("saveState preserves task-owned thread metadata and drops malformed ownership", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-valid");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_valid",
          name: "Valid workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "task_thread_valid",
          workspaceId: "ws_valid",
          title: "Task thread",
          titleSource: "manual",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: "task_session_valid",
          messageCount: 4,
          lastEventSeq: 9,
          taskId: "task_valid",
          taskThreadId: "task_thread_owner",
        },
        {
          id: "task_thread_malformed",
          workspaceId: "ws_valid",
          title: "Malformed task thread",
          titleSource: "manual",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: "task_session_malformed",
          messageCount: 1,
          lastEventSeq: 1,
          taskId: "../task",
          taskThreadId: "",
        },
      ],
    });

    const loaded = await persistence.loadState();
    expect(loaded.threads).toEqual([
      expect.objectContaining({
        id: "task_thread_valid",
        sessionId: "task_session_valid",
        taskId: "task_valid",
        taskThreadId: "task_thread_owner",
      }),
      expect.not.objectContaining({
        taskId: expect.any(String),
        taskThreadId: expect.any(String),
      }),
    ]);
  });

  test("saveState preserves subagent thread identity and safely sanitizes parent linkage", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-subagents");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_subagents",
          name: "Subagent workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "root_thread",
          workspaceId: "ws_subagents",
          sessionKind: "root",
          parentSessionId: null,
          title: "Root chat",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: "root_session",
          messageCount: 1,
          lastEventSeq: 1,
        },
        {
          id: "agent_thread",
          workspaceId: "ws_subagents",
          sessionKind: "agent",
          parentSessionId: "root_session",
          title: "Subagent run",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: "agent_session",
          messageCount: 1,
          lastEventSeq: 1,
        },
        {
          id: "malformed_thread",
          workspaceId: "ws_subagents",
          sessionKind: "worker" as "agent",
          parentSessionId: "../root_session",
          title: "Malformed session identity",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: "malformed_session",
          messageCount: 1,
          lastEventSeq: 1,
        },
        {
          id: "malformed_parent_thread",
          workspaceId: "ws_subagents",
          sessionKind: "agent",
          parentSessionId: 42 as unknown as string,
          title: "Malformed parent linkage",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: "malformed_parent_session",
          messageCount: 1,
          lastEventSeq: 1,
        },
      ],
    });

    const loaded = await persistence.loadState();
    const rootThread = loaded.threads.find((thread) => thread.id === "root_thread");
    const agentThread = loaded.threads.find((thread) => thread.id === "agent_thread");
    const malformedThread = loaded.threads.find((thread) => thread.id === "malformed_thread");
    const malformedParentThread = loaded.threads.find(
      (thread) => thread.id === "malformed_parent_thread",
    );

    expect(rootThread).toMatchObject({ sessionKind: "root", parentSessionId: null });
    expect(agentThread).toMatchObject({ sessionKind: "agent", parentSessionId: "root_session" });
    expect(isStandardChatThread(agentThread!)).toBe(false);
    expect(malformedThread).not.toHaveProperty("sessionKind");
    expect(malformedThread).not.toHaveProperty("parentSessionId");
    expect(malformedParentThread).toMatchObject({ sessionKind: "agent" });
    expect(malformedParentThread).not.toHaveProperty("parentSessionId");
  });

  test("saveState preserves yolo configuration", async () => {
    const persistence = new PersistenceService();
    const workspaceYoloTrue = path.join(userDataDir, "workspace-yolo-true");
    const workspaceYoloFalse = path.join(userDataDir, "workspace-yolo-false");
    await fs.mkdir(workspaceYoloTrue, { recursive: true });
    await fs.mkdir(workspaceYoloFalse, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_yolo_true",
          name: "Yolo True Workspace",
          path: workspaceYoloTrue,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: true,
        },
        {
          id: "ws_yolo_false",
          name: "Yolo False Workspace",
          path: workspaceYoloFalse,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
      ],
      threads: [],
    });

    const loaded = await persistence.loadState();
    expect(loaded.workspaces).toHaveLength(2);
    const wsTrue = loaded.workspaces.find((w) => w.id === "ws_yolo_true");
    const wsFalse = loaded.workspaces.find((w) => w.id === "ws_yolo_false");
    expect(wsTrue?.yolo).toBe(true);
    expect(wsFalse?.yolo).toBe(false);
  });

  test("recreates one-off chat folders while preserving unavailable projects and their history", async () => {
    const persistence = new PersistenceService();
    const missingProject = path.join(userDataDir, "workspace-missing-project");
    const oneOffChat = path.join(
      appDataDir,
      ".cowork",
      "chats",
      `persistence-test-${crypto.randomUUID()}`,
    );
    oneOffTestDirs.push(oneOffChat);

    await fs.rm(oneOffChat, { recursive: true, force: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_missing_project",
          name: "Missing project",
          path: missingProject,
          workspaceKind: "project",
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
        {
          id: "ws_one_off",
          name: "One-off chat",
          path: oneOffChat,
          workspaceKind: "oneOffChat",
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread_unavailable_project",
          workspaceId: "ws_missing_project",
          title: "History on an unavailable drive",
          createdAt: TS,
          lastMessageAt: TS,
          status: "disconnected",
          sessionId: "project-session",
          messageCount: 3,
          lastEventSeq: 9,
        },
        {
          id: "thread_one_off",
          workspaceId: "ws_one_off",
          title: "One-off thread",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: null,
          messageCount: 0,
          lastEventSeq: 0,
        },
      ],
    });

    const loaded = await persistence.loadState();
    expect(loaded.workspaces.map((workspace) => workspace.id)).toEqual([
      "ws_missing_project",
      "ws_one_off",
    ]);
    expect(loaded.workspaces[0]).toMatchObject({
      workspaceKind: "project",
      path: missingProject,
    });
    expect(loaded.workspaces[1]?.workspaceKind).toBe("oneOffChat");
    expect(loaded.threads.map((thread) => thread.id)).toEqual([
      "thread_unavailable_project",
      "thread_one_off",
    ]);

    const stat = await fs.stat(oneOffChat);
    expect(stat.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o700);
    }
  });

  test("keeps a project's conversations across unplug, another save, and remount", async () => {
    const persistence = new PersistenceService();
    const projectPath = path.join(userDataDir, "removable-project");
    const detachedPath = path.join(userDataDir, "removable-project-detached");
    await fs.mkdir(projectPath, { recursive: true });
    const canonicalProjectPath = await fs.realpath(projectPath);

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_removable",
          name: "External project",
          path: projectPath,
          workspaceKind: "project",
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread_removable",
          workspaceId: "ws_removable",
          title: "Do not lose this conversation",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: "removable-session",
          messageCount: 8,
          lastEventSeq: 21,
        },
      ],
    });

    await fs.rename(projectPath, detachedPath);

    const disconnected = await persistence.loadState();
    expect(disconnected.workspaces).toEqual([
      expect.objectContaining({ id: "ws_removable", path: canonicalProjectPath }),
    ]);
    expect(disconnected.threads).toEqual([
      expect.objectContaining({ id: "thread_removable", messageCount: 8, lastEventSeq: 21 }),
    ]);

    await persistence.saveState({ ...disconnected, developerMode: true });
    const savedWhileDisconnected = await persistence.loadState();
    expect(savedWhileDisconnected.workspaces[0]?.id).toBe("ws_removable");
    expect(savedWhileDisconnected.threads[0]?.id).toBe("thread_removable");
    expect(savedWhileDisconnected.developerMode).toBe(true);

    await fs.rename(detachedPath, projectPath);

    const remounted = await persistence.loadState();
    expect(remounted.workspaces).toEqual([
      expect.objectContaining({ id: "ws_removable", path: canonicalProjectPath }),
    ]);
    expect(remounted.threads).toEqual([
      expect.objectContaining({ id: "thread_removable", sessionId: "removable-session" }),
    ]);
  });

  test("preserves an explicitly promoted project inside the chat workspace root", async () => {
    const persistence = new PersistenceService();
    const oneOffChat = path.join(
      appDataDir,
      ".cowork",
      "chats",
      `persistence-kind-test-${crypto.randomUUID()}`,
    );
    oneOffTestDirs.push(oneOffChat);
    await fs.mkdir(oneOffChat, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_chat_legacy_kind",
          name: "Chat folder",
          path: oneOffChat,
          workspaceKind: "project",
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
      ],
      threads: [],
    });

    const loaded = await persistence.loadState();
    expect(loaded.workspaces).toHaveLength(1);
    expect(loaded.workspaces[0]?.workspaceKind).toBe("project");
    expect(loaded.workspaces[0]?.path).toBe(await fs.realpath(oneOffChat));
  });

  test("saveState preserves sanitized provider status snapshots", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-provider");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_provider",
          name: "Provider workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      providerState: {
        statusByName: {
          "codex-cli": {
            provider: "codex-cli",
            authorized: true,
            verified: false,
            mode: "oauth",
            account: { email: "max@example.com" },
            message: "Codex credentials present.",
            checkedAt: TS,
          },
        },
        statusLastUpdatedAt: TS,
      },
    });

    const loaded = await persistence.loadState();
    expect(loaded.providerState?.statusLastUpdatedAt).toBe(TS);
    expect(loaded.providerState?.statusByName?.["codex-cli"]?.authorized).toBe(true);
    expect(loaded.providerState?.statusByName?.["codex-cli"]?.mode).toBe("oauth");
    expect(loaded.providerState?.statusByName?.["codex-cli"]?.account?.email).toBe(
      "max@example.com",
    );
  });

  test("saveState preserves LM Studio UI visibility preferences", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-lmstudio-ui");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_lmstudio_ui",
          name: "LM Studio workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      providerUiState: {
        lmstudio: {
          enabled: true,
          hiddenModels: ["llama-3.2-vision"],
        },
      },
    });

    const loaded = await persistence.loadState();
    expect(loaded.providerUiState).toEqual({
      lmstudio: {
        enabled: true,
        hiddenModels: ["llama-3.2-vision"],
      },
    });
  });

  test("saveState persists quick chat shortcut preferences", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-quick-chat");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_quick_chat",
          name: "Quick chat workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      desktopSettings: {
        quickChat: {
          iconEnabled: false,
          shortcutEnabled: true,
          shortcutAccelerator: "Alt+Space",
        },
        sidebarSectionOrder: ["chats", "projects"],
      },
      privacyTelemetrySettings: {
        crashReportsEnabled: true,
        productAnalyticsEnabled: false,
        aiTraceTelemetryEnabled: true,
        aiTracePayloadsEnabled: true,
        diagnosticsUploadEnabled: true,
        cloudSyncEnabled: false,
      },
      cloudSync: {
        enabled: true,
        provider: "custom",
        endpoint: " https://sync.example.test ",
        syncSettings: true,
        syncWorkspaceMetadata: false,
        syncThreads: false,
      },
    });

    const loaded = await persistence.loadState();
    expect(loaded.desktopSettings?.quickChat?.iconEnabled).toBe(false);
    expect(loaded.desktopSettings?.quickChat?.shortcutEnabled).toBe(true);
    expect(loaded.desktopSettings?.quickChat?.shortcutAccelerator).toBe("Alt+Space");
    expect(loaded.desktopSettings?.sidebarSectionOrder).toEqual(["chats", "projects"]);
    expect(loaded.privacyTelemetrySettings).toEqual({
      crashReportsEnabled: true,
      productAnalyticsEnabled: false,
      aiTraceTelemetryEnabled: true,
      aiTracePayloadsEnabled: true,
      diagnosticsUploadEnabled: true,
      cloudSyncEnabled: false,
    });
    expect(loaded.cloudSync).toEqual({
      enabled: true,
      provider: "custom",
      endpoint: "https://sync.example.test",
      syncSettings: true,
      syncWorkspaceMetadata: false,
      syncThreads: false,
    });
  });

  test("loadState enables LM Studio UI by default when the saved provider status is already connected", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-lmstudio-default");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_lmstudio_default",
          name: "LM Studio workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      providerState: {
        statusByName: {
          lmstudio: {
            provider: "lmstudio",
            authorized: true,
            verified: true,
            mode: "local",
            account: null,
            message: "LM Studio reachable.",
            checkedAt: TS,
          },
        },
        statusLastUpdatedAt: TS,
      },
    });

    const loaded = await persistence.loadState();
    expect(loaded.providerUiState?.lmstudio.enabled).toBe(true);
    expect(loaded.providerUiState?.lmstudio.hiddenModels).toEqual([]);
  });

  test("saveState preserves workspace tool output overflow defaults", async () => {
    const persistence = new PersistenceService();
    const customWorkspace = path.join(userDataDir, "workspace-overflow-custom");
    const disabledWorkspace = path.join(userDataDir, "workspace-overflow-disabled");
    const inheritedWorkspace = path.join(userDataDir, "workspace-overflow-inherited");
    await fs.mkdir(customWorkspace, { recursive: true });
    await fs.mkdir(disabledWorkspace, { recursive: true });
    await fs.mkdir(inheritedWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_overflow_custom",
          name: "Custom overflow workspace",
          path: customWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultToolOutputOverflowChars: 12000,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
        {
          id: "ws_overflow_disabled",
          name: "Disabled overflow workspace",
          path: disabledWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultToolOutputOverflowChars: null,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
        {
          id: "ws_overflow_inherited",
          name: "Inherited overflow workspace",
          path: inheritedWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    });

    const loaded = await persistence.loadState();
    expect(
      loaded.workspaces.find((workspace) => workspace.id === "ws_overflow_custom")
        ?.defaultToolOutputOverflowChars,
    ).toBe(12000);
    expect(
      loaded.workspaces.find((workspace) => workspace.id === "ws_overflow_disabled")
        ?.defaultToolOutputOverflowChars,
    ).toBeNull();
    expect(
      loaded.workspaces.find((workspace) => workspace.id === "ws_overflow_inherited")
        ?.defaultToolOutputOverflowChars,
    ).toBeUndefined();
  });

  test("saveState preserves workspace user profile defaults", async () => {
    const persistence = new PersistenceService();
    const profileWorkspace = path.join(userDataDir, "workspace-profile");
    await fs.mkdir(profileWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_profile",
          name: "Profile workspace",
          path: profileWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          userName: "Alex",
          userProfile: {
            instructions: "Keep answers terse.",
            work: "Platform engineer",
            details: "Prefers Bun",
          },
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    });

    const loaded = await persistence.loadState();
    expect(loaded.workspaces[0]?.userName).toBe("Alex");
    expect(loaded.workspaces[0]?.userProfile).toEqual({
      instructions: "Keep answers terse.",
      work: "Platform engineer",
      details: "Prefers Bun",
    });
  });

  test("saveState preserves workspace cross-provider child routing defaults", async () => {
    const persistence = new PersistenceService();
    const routingWorkspace = path.join(userDataDir, "workspace-child-routing");
    await fs.mkdir(routingWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_child_routing",
          name: "Child routing workspace",
          path: routingWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultProvider: "codex-cli",
          defaultModel: "gpt-5.4",
          defaultPreferredChildModel: "gpt-5.4",
          defaultChildModelRoutingMode: "cross-provider-allowlist",
          defaultPreferredChildModelRef: "opencode-zen:glm-5",
          defaultAllowedChildModelRefs: ["opencode-zen:glm-5", "opencode-go:glm-5"],
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    });

    const loaded = await persistence.loadState();
    expect(loaded.workspaces[0]?.defaultChildModelRoutingMode).toBe("cross-provider-allowlist");
    expect(loaded.workspaces[0]?.defaultPreferredChildModelRef).toBe("opencode-zen:glm-5");
    expect(loaded.workspaces[0]?.defaultAllowedChildModelRefs).toEqual([
      "opencode-zen:glm-5",
      "opencode-go:glm-5",
    ]);
  });

  test("saveState drops recoverable expired codex status snapshots that would look disconnected on restart", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-provider-recoverable");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_provider_recoverable",
          name: "Recoverable provider workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      providerState: {
        statusByName: {
          "codex-cli": {
            provider: "codex-cli",
            authorized: false,
            verified: false,
            mode: "oauth",
            account: { email: "max@example.com" },
            message: "Codex token expired. Token refresh failed: temporary outage",
            checkedAt: TS,
            tokenRecoverable: true,
          },
        },
        statusLastUpdatedAt: TS,
      },
    });

    const loaded = await persistence.loadState();
    expect(loaded.providerState?.statusByName?.["codex-cli"]).toBeUndefined();
    expect(loaded.providerState?.statusLastUpdatedAt).toBe(TS);
  });

  test("loadState sanitizes malformed on-disk payloads instead of failing", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-from-disk");
    await fs.mkdir(validWorkspace, { recursive: true });

    const statePath = path.join(userDataDir, "state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: "bad",
          workspaces: [
            {
              id: "",
              name: 123,
              path: validWorkspace,
              createdAt: "not-a-date",
              lastOpenedAt: TS,
            },
          ],
          threads: [
            {
              id: "thread_disk",
              workspaceId: "ws_disk",
              title: "Thread",
              createdAt: TS,
              lastMessageAt: TS,
              status: "unknown",
            },
          ],
          providerState: {
            statusByName: {
              "codex-cli": {
                provider: "totally-wrong",
                authorized: "yes",
              },
            },
            statusLastUpdatedAt: 123,
          },
          developerMode: "sometimes",
          showHiddenFiles: "always",
          privacyTelemetrySettings: {
            crashReportsEnabled: "yes",
            productAnalyticsEnabled: 1,
            aiTraceTelemetryEnabled: false,
            aiTracePayloadsEnabled: true,
            diagnosticsUploadEnabled: null,
            cloudSyncEnabled: {},
          },
          cloudSync: {
            enabled: "yes",
            provider: "none",
            endpoint: "/Users/me/secret",
            syncSettings: false,
            syncWorkspaceMetadata: "yes",
            syncThreads: {},
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = await persistence.loadState();
    expect(loaded.version).toBe(2);
    expect(loaded.workspaces).toEqual([]);
    expect(loaded.threads).toEqual([]);
    expect(loaded.developerMode).toBe(false);
    expect(loaded.showHiddenFiles).toBe(false);
    expect(loaded.privacyTelemetrySettings).toEqual({
      crashReportsEnabled: false,
      productAnalyticsEnabled: false,
      aiTraceTelemetryEnabled: false,
      aiTracePayloadsEnabled: false,
      diagnosticsUploadEnabled: false,
      cloudSyncEnabled: false,
    });
    expect(loaded.cloudSync).toEqual({
      enabled: false,
      provider: "none",
      syncSettings: false,
      syncWorkspaceMetadata: false,
      syncThreads: false,
    });
    expect(loaded.providerState).toBeUndefined();
  });

  test("loadState migrates legacy defaultSubAgentModel values from disk", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-legacy-child-model");
    await fs.mkdir(validWorkspace, { recursive: true });

    const statePath = path.join(userDataDir, "state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 2,
          workspaces: [
            {
              id: "ws_legacy_child_model",
              name: "Legacy child model workspace",
              path: validWorkspace,
              createdAt: TS,
              lastOpenedAt: TS,
              defaultProvider: "openai",
              defaultModel: "gpt-5.2",
              defaultSubAgentModel: "gpt-5.2-mini",
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              yolo: false,
            },
          ],
          threads: [],
          developerMode: false,
          showHiddenFiles: false,
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = await persistence.loadState();
    expect(loaded.workspaces[0]?.defaultPreferredChildModel).toBe("gpt-5.2-mini");
  });

  test("loadState recovers from invalid JSON", async () => {
    const persistence = new PersistenceService();

    const statePath = path.join(userDataDir, "state.json");
    await fs.writeFile(statePath, "{not-json", "utf8");

    const loaded = await persistence.loadState();
    expect(loaded).toEqual({
      version: 2,
      workspaces: [],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      perWorkspaceSettings: false,
      desktopSettings: {
        quickChat: {
          iconEnabled: true,
          shortcutEnabled: false,
          shortcutAccelerator: "CommandOrControl+Shift+Space",
        },
        archivedChatsAutoDeleteDays: 0,
        sidebarSectionOrder: ["projects", "chats"],
      },
      privacyTelemetrySettings: {
        crashReportsEnabled: false,
        productAnalyticsEnabled: false,
        aiTraceTelemetryEnabled: false,
        aiTracePayloadsEnabled: false,
        diagnosticsUploadEnabled: false,
        cloudSyncEnabled: false,
      },
      cloudSync: {
        enabled: false,
        provider: "none",
        syncSettings: true,
        syncWorkspaceMetadata: false,
        syncThreads: false,
      },
      desktopFeatureFlagOverrides: {},
      providerUiState: {
        lmstudio: {
          enabled: false,
          hiddenModels: [],
        },
      },
    });
  });

  test("readTranscript skips malformed lines", async () => {
    const persistence = new PersistenceService();
    const transcriptDir = path.join(userDataDir, "transcripts");
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, "thread_1.jsonl");

    const validEventA = JSON.stringify({
      ts: TS,
      threadId: "thread_1",
      direction: "server",
      payload: { type: "log", line: "a" },
    });
    const invalidJson = "{not-json";
    const invalidShape = JSON.stringify({
      ts: TS,
      threadId: "thread_1",
      direction: "sideways",
      payload: {},
    });
    const validEventB = JSON.stringify({
      ts: TS,
      threadId: "thread_1",
      direction: "client",
      payload: { type: "ping" },
    });
    await fs.writeFile(
      transcriptPath,
      `${validEventA}\n${invalidJson}\n${invalidShape}\n${validEventB}\n`,
      "utf8",
    );

    const transcript = await persistence.readTranscript("thread_1");
    expect(transcript).toHaveLength(2);
    expect(transcript[0]?.direction).toBe("server");
    expect(transcript[1]?.direction).toBe("client");
  });

  test("loadState migrates legacy desktop user data into Cowork on first access", async () => {
    const persistence = new PersistenceService();
    const legacyDir = path.join(appDataDir, "desktop");
    const legacyWorkspace = path.join(legacyDir, "workspace-from-legacy");
    const legacyTranscriptDir = path.join(legacyDir, "transcripts");
    await fs.mkdir(legacyWorkspace, { recursive: true });
    await fs.mkdir(legacyTranscriptDir, { recursive: true });

    await fs.writeFile(
      path.join(legacyDir, "state.json"),
      JSON.stringify(
        {
          version: 2,
          workspaces: [
            {
              id: "ws_legacy",
              name: "Legacy workspace",
              path: legacyWorkspace,
              createdAt: TS,
              lastOpenedAt: TS,
              defaultEnableMcp: true,
              yolo: false,
            },
          ],
          threads: [
            {
              id: "thread_legacy",
              workspaceId: "ws_legacy",
              title: "Legacy thread",
              createdAt: TS,
              lastMessageAt: TS,
              status: "active",
              sessionId: null,
              lastEventSeq: 0,
            },
          ],
          developerMode: false,
          showHiddenFiles: false,
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(legacyTranscriptDir, "thread_legacy.jsonl"),
      `${JSON.stringify({ ts: TS, threadId: "thread_legacy", direction: "server", payload: { type: "log" } })}\n`,
      "utf8",
    );

    const loaded = await persistence.loadState();
    const transcript = await persistence.readTranscript("thread_legacy");

    expect(loaded.workspaces).toHaveLength(1);
    expect(loaded.workspaces[0]?.id).toBe("ws_legacy");
    expect(loaded.workspaces[0]?.wsProtocol).toBe("jsonrpc");
    expect(transcript).toHaveLength(1);
    expect(await fs.readFile(path.join(userDataDir, "state.json"), "utf8")).toContain(
      '"ws_legacy"',
    );
    expect(
      await fs.readFile(path.join(userDataDir, "transcripts", "thread_legacy.jsonl"), "utf8"),
    ).toContain('"thread_legacy"');
  });
});
