import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import type { SessionContext } from "../src/server/session/SessionContext";
import { HistoryManager } from "../src/server/session/HistoryManager";
import { McpManager } from "../src/server/session/McpManager";
import { SessionAdminManager } from "../src/server/session/SessionAdminManager";
import { SessionMetadataManager } from "../src/server/session/SessionMetadataManager";

function makeBaseContext(): SessionContext {
  return {
    id: "session-1",
    state: {
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
        subAgentModel: "gemini-3-flash-preview",
        workingDirectory: "/tmp/project",
        userName: "",
        knowledgeCutoff: "unknown",
        projectAgentDir: "/tmp/project/.agent",
        userAgentDir: "/tmp/.agent",
        builtInDir: "/tmp/project",
        builtInConfigDir: "/tmp/project/config",
        skillsDirs: [],
        memoryDirs: [],
        configDirs: [],
        enableMcp: true,
      },
      system: "system",
      discoveredSkills: [],
      yolo: false,
      messages: [],
      allMessages: [],
      running: false,
      connecting: false,
      abortController: null,
      currentTurnId: null,
      currentTurnOutcome: "completed",
      maxSteps: 100,
      todos: [],
      sessionInfo: {
        title: "New Session",
        titleSource: "default",
        titleModel: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        provider: "google",
        model: "gemini-3-flash-preview",
      },
      persistenceStatus: "active",
      hasGeneratedTitle: false,
      sessionBackup: null,
      sessionBackupState: {
        status: "initializing",
        sessionId: "session-1",
        workingDirectory: "/tmp/project",
        backupDirectory: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        originalSnapshot: { kind: "pending" },
        checkpoints: [],
      },
      sessionBackupInit: null,
      backupOperationQueue: Promise.resolve(),
      lastAutoCheckpointAt: 0,
    },
    deps: {
      connectProviderImpl: async () => ({ ok: true, provider: "google", mode: "api_key", message: "ok" } as any),
      getAiCoworkerPathsImpl: () => ({ sessionsDir: "/tmp/sessions" } as any),
      getProviderCatalogImpl: async () => ({ all: [], default: {}, connected: [] }),
      getProviderStatusesImpl: async () => [],
      sessionBackupFactory: async () => ({ getPublicState: () => ({}), reloadFromDisk: async () => ({}) } as any),
      harnessContextStore: {
        get: () => null,
        set: (_id: string, value: any) => value,
        clear: () => {},
      } as any,
      runTurnImpl: async () => ({ text: "", responseMessages: [] }),
      generateSessionTitleImpl: async () => ({ title: "Generated", source: "heuristic", model: null }),
      sessionDb: null,
      writePersistedSessionSnapshotImpl: async () => undefined,
    },
    emit: () => {},
    emitError: () => {},
    emitTelemetry: () => {},
    formatError: (err) => String(err),
    guardBusy: () => true,
    getCoworkPaths: () => ({ sessionsDir: "/tmp/sessions" } as any),
    runProviderConnect: async () => ({ ok: true, provider: "google", mode: "api_key", message: "ok" } as any),
    getMcpServerByName: async () => null,
    queuePersistSessionSnapshot: () => {},
    updateSessionInfo: () => {},
    emitConfigUpdated: () => {},
    refreshProviderStatus: async () => {},
    emitProviderCatalog: async () => {},
  };
}

describe("session managers", () => {
  test("HistoryManager keeps first + last 199 runtime messages", () => {
    const context = makeBaseContext();
    context.state.allMessages = Array.from({ length: 250 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m-${i}`,
    })) as any;
    const manager = new HistoryManager(context);

    manager.refreshRuntimeMessagesFromHistory();

    expect(context.state.messages.length).toBe(200);
    expect((context.state.messages[0] as any).content).toBe("m-0");
    expect((context.state.messages[199] as any).content).toBe("m-249");
  });

  test("SessionMetadataManager setSessionTitle updates info and queues persistence", () => {
    const context = makeBaseContext();
    const emitted: any[] = [];
    const persistedReasons: string[] = [];
    context.emit = (evt) => emitted.push(evt);
    context.queuePersistSessionSnapshot = (reason) => persistedReasons.push(reason);
    const manager = new SessionMetadataManager(context);

    manager.setSessionTitle("  Refactor Session  ");

    expect(context.state.hasGeneratedTitle).toBe(true);
    expect(context.state.sessionInfo.title).toBe("Refactor Session");
    expect(context.state.sessionInfo.titleSource).toBe("manual");
    expect(persistedReasons).toContain("session_info.updated");
    expect(emitted.some((evt) => evt.type === "session_info")).toBe(true);
  });

  test("McpManager validate emits error event when lookup throws and clears connecting", async () => {
    const context = makeBaseContext();
    const emitted: any[] = [];
    context.emit = (evt) => emitted.push(evt);
    context.getMcpServerByName = async () => {
      throw new Error("lookup failed");
    };
    const manager = new McpManager(context);

    await manager.validate("demo");

    const evt = emitted.find((entry) => entry.type === "mcp_server_validation");
    expect(evt).toBeDefined();
    expect(evt.ok).toBe(false);
    expect(String(evt.message)).toContain("lookup failed");
    expect(context.state.connecting).toBe(false);
  });

  test("SessionAdminManager lists workspace files and reads file content", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-session-admin-"));
    try {
      await fs.mkdir(path.join(workspaceDir, "src"));
      await fs.writeFile(path.join(workspaceDir, "README.md"), "# hello workspace", "utf-8");

      const context = makeBaseContext();
      context.state.config.workingDirectory = workspaceDir;
      const emitted: any[] = [];
      context.emit = (event) => emitted.push(event);
      const manager = new SessionAdminManager(context);

      await manager.getWorkspaceFiles();

      const filesEvent = emitted.find((event) => event.type === "workspace_files");
      expect(filesEvent).toBeDefined();
      expect(filesEvent.workspacePath).toBe(workspaceDir);
      expect(filesEvent.directory).toBe("");
      expect(filesEvent.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "README.md", kind: "file" }),
        expect.objectContaining({ path: "src", kind: "directory" }),
      ]));

      emitted.length = 0;
      await manager.readWorkspaceFile("README.md");

      const fileEvent = emitted.find((event) => event.type === "workspace_file_content");
      expect(fileEvent).toBeDefined();
      expect(fileEvent.path).toBe("README.md");
      expect(fileEvent.content).toBe("# hello workspace");
      expect(fileEvent.binary).toBe(false);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("SessionAdminManager truncates large workspace file previews", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-session-admin-large-"));
    const largeContent = "a".repeat(300 * 1024);
    try {
      await fs.writeFile(path.join(workspaceDir, "large.log"), largeContent, "utf-8");

      const context = makeBaseContext();
      context.state.config.workingDirectory = workspaceDir;
      const emitted: any[] = [];
      context.emit = (event) => emitted.push(event);
      const manager = new SessionAdminManager(context);

      await manager.readWorkspaceFile("large.log");

      const fileEvent = emitted.find((event) => event.type === "workspace_file_content");
      expect(fileEvent).toBeDefined();
      expect(fileEvent.path).toBe("large.log");
      expect(fileEvent.binary).toBe(false);
      expect(fileEvent.truncated).toBe(true);
      expect(fileEvent.totalBytes).toBe(largeContent.length);
      expect(fileEvent.content).toBe(largeContent.slice(0, 256 * 1024));
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
