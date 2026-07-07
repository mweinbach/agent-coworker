import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionRegistry } from "../src/server/runtime/SessionRegistry";
import { ThreadJournal } from "../src/server/runtime/ThreadJournal";
import { SessionDb } from "../src/server/sessionDb";
import { LocalThreadHost } from "../src/server/threads/localThreadHost";
import type { AgentConfig } from "../src/types";

async function makeHarness(opts: { isTaskThread?: (sessionId: string) => boolean } = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-thread-management-"));
  const rootDir = path.join(workspace, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionDb = await SessionDb.create({ paths: { rootDir, sessionsDir } });
  const threadJournal = new ThreadJournal(sessionDb);
  const config: AgentConfig = {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: workspace,
    outputDirectory: path.join(workspace, "output"),
    uploadsDirectory: path.join(workspace, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: rootDir,
    userCoworkDir: path.join(workspace, ".cowork-user"),
    builtInDir: workspace,
    builtInConfigDir: path.join(workspace, "config"),
    skillsDirs: [path.join(workspace, ".cowork-user", "skills")],
    memoryDirs: [],
    configDirs: [],
  };
  const registry = {
    sessionBindings: new Map(),
    listLiveRoot: () => [],
    readThreadSnapshot: () => null,
    loadThreadBinding: () => null,
    createJsonRpcThreadSession: () => {
      throw new Error("not used");
    },
  } as unknown as SessionRegistry;
  const host = new LocalThreadHost({
    sessionDb,
    registry,
    threadJournal,
    taskCoordinator: { isTaskThread: opts.isTaskThread ?? (() => false) },
    getConfig: () => config,
    homedir: workspace,
  });
  return { workspace, sessionDb, threadJournal, host };
}

async function persistThread(sessionDb: SessionDb, workspace: string) {
  await sessionDb.persistSessionMutation({
    sessionId: "thread-1",
    eventType: "session.created",
    eventTs: "2026-07-01T00:00:00.000Z",
    snapshot: {
      sessionKind: "root",
      parentSessionId: null,
      role: null,
      title: "Thread One",
      titleSource: "manual",
      titleModel: null,
      provider: "google",
      model: "gemini-3-flash-preview",
      workingDirectory: workspace,
      enableMcp: true,
      backupsEnabledOverride: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:01.000Z",
      status: "active",
      hasPendingAsk: false,
      hasPendingApproval: false,
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      providerState: null,
      todos: [],
      harnessContext: null,
      costTracker: null,
    },
  });
}

describe("LocalThreadHost", () => {
  test("readThread omits tool outputs by default and truncates included outputs", async () => {
    const { workspace, sessionDb, threadJournal, host } = await makeHarness();
    try {
      await persistThread(sessionDb, workspace);
      await sessionDb.appendThreadJournalEvents([
        {
          threadId: "thread-1",
          ts: "2026-07-01T00:00:01.000Z",
          eventType: "turn/started",
          turnId: "turn-1",
          itemId: null,
          requestId: null,
          payload: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
        },
        {
          threadId: "thread-1",
          ts: "2026-07-01T00:00:02.000Z",
          eventType: "item/completed",
          turnId: "turn-1",
          itemId: "tool-1",
          requestId: null,
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "tool-1",
              type: "toolCall",
              toolName: "bash",
              state: "output-available",
              args: { command: "printf" },
              result: "abcdefghijklmnopqrstuvwxyz",
            },
          },
        },
        {
          threadId: "thread-1",
          ts: "2026-07-01T00:00:03.000Z",
          eventType: "turn/completed",
          turnId: "turn-1",
          itemId: null,
          requestId: null,
          payload: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        },
      ]);

      const compact = await host.readThread({ threadId: "thread-1" });
      expect(compact.turns[0]?.items[0]).toEqual({
        type: "tool",
        toolName: "bash",
        state: "output-available",
        args: { command: "printf" },
      });

      const withOutput = await host.readThread({
        threadId: "thread-1",
        includeOutputs: true,
        maxOutputCharsPerItem: 10,
      });
      expect(withOutput.turns[0]?.items[0]).toEqual({
        type: "tool",
        toolName: "bash",
        state: "output-available",
        args: { command: "printf" },
        output: "abcdefghij…",
        outputTruncated: true,
      });
    } finally {
      await threadJournal.close();
      sessionDb.close();
    }
  });

  test("rejects direct management of task-owned threads", async () => {
    const { workspace, sessionDb, threadJournal, host } = await makeHarness({
      isTaskThread: (sessionId) => sessionId === "thread-1",
    });
    try {
      await persistThread(sessionDb, workspace);

      await expect(host.readThread({ threadId: "thread-1" })).rejects.toThrow(
        "Task-owned threads are not managed by thread-management tools",
      );
      await expect(host.setPinned({ threadId: "thread-1", pinned: true })).rejects.toThrow(
        "Task-owned threads are not managed by thread-management tools",
      );
      expect(sessionDb.getThreadMetadata("thread-1")).toBeNull();
    } finally {
      await threadJournal.close();
      sessionDb.close();
    }
  });

  test("does not persist metadata for unknown threads", async () => {
    const { sessionDb, threadJournal, host } = await makeHarness();
    try {
      await expect(host.setPinned({ threadId: "missing", pinned: true })).rejects.toThrow(
        "Unknown thread: missing",
      );
      expect(sessionDb.getThreadMetadata("missing")).toBeNull();
    } finally {
      await threadJournal.close();
      sessionDb.close();
    }
  });

  test("listThreads sorts pinned threads first and hides archived threads unless queried", async () => {
    const { workspace, sessionDb, threadJournal, host } = await makeHarness();
    try {
      await persistThread(sessionDb, workspace);
      await sessionDb.persistSessionMutation({
        sessionId: "thread-2",
        eventType: "session.created",
        eventTs: "2026-07-01T00:00:04.000Z",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Archived Thread",
          titleSource: "manual",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: workspace,
          enableMcp: true,
          backupsEnabledOverride: null,
          createdAt: "2026-07-01T00:00:04.000Z",
          updatedAt: "2026-07-01T00:00:05.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "archived" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });
      await sessionDb.setThreadMetadata({
        threadId: "thread-1",
        pinned: true,
        updatedAt: "2026-07-01T00:00:06.000Z",
      });
      await sessionDb.setThreadMetadata({
        threadId: "thread-2",
        archived: true,
        updatedAt: "2026-07-01T00:00:07.000Z",
      });

      const defaultList = await host.listThreads({});
      expect(defaultList.threads.map((thread) => thread.threadId)).toEqual(["thread-1"]);
      expect(defaultList.threads[0]?.pinned).toBe(true);

      const queried = await host.listThreads({ query: "archived" });
      expect(queried.threads.map((thread) => thread.threadId)).toEqual(["thread-2"]);
      expect(queried.threads[0]?.archived).toBe(true);
    } finally {
      await threadJournal.close();
      sessionDb.close();
    }
  });
});
