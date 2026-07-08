import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { scratchRoots } from "../src/platform/sandbox";
import type { SessionRegistry } from "../src/server/runtime/SessionRegistry";
import { ThreadJournal } from "../src/server/runtime/ThreadJournal";
import { SessionDb } from "../src/server/sessionDb";
import { LocalThreadHost } from "../src/server/threads/localThreadHost";
import type { WebDesktopServiceLike } from "../src/server/webDesktopService";
import type { AgentConfig } from "../src/types";

async function makeHarness(
  opts: {
    isTaskThread?: (sessionId: string) => boolean;
    registry?: Partial<SessionRegistry>;
    worktreeService?: ConstructorParameters<typeof LocalThreadHost>[0]["worktreeService"];
    desktopService?: WebDesktopServiceLike;
    loadThreadSessionBootstrap?: ConstructorParameters<
      typeof LocalThreadHost
    >[0]["loadThreadSessionBootstrap"];
  } = {},
) {
  const workspace = await fs.mkdtemp(
    path.join(scratchRoots()[0] ?? "/tmp", "cowork-thread-management-"),
  );
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
    ...opts.registry,
  } as unknown as SessionRegistry;
  const host = new LocalThreadHost({
    sessionDb,
    registry,
    threadJournal,
    taskCoordinator: { isTaskThread: opts.isTaskThread ?? (() => false) },
    worktreeService: opts.worktreeService,
    desktopService: opts.desktopService,
    getConfig: () => config,
    loadThreadSessionBootstrap: opts.loadThreadSessionBootstrap,
    homedir: workspace,
  });
  return { workspace, sessionDb, threadJournal, host };
}

function makeRuntime(opts: {
  id: string;
  cwd: string;
  provider?: AgentConfig["provider"];
  model?: string;
  title?: string;
  isBusy?: boolean;
  messageCount?: number;
  sendUserMessage?: (prompt: string) => Promise<void>;
}) {
  const provider = opts.provider ?? "google";
  const model = opts.model ?? "gemini-3-flash-preview";
  const now = "2026-07-01T00:00:10.000Z";
  return {
    id: opts.id,
    read: {
      sessionKind: "root",
      parentSessionId: null,
      role: null,
      isBusy: opts.isBusy ?? false,
      workingDirectory: opts.cwd,
      publicConfig: { provider, model, providerOptions: {} },
      info: {
        title: opts.title ?? "Forked thread",
        titleSource: "manual",
        titleModel: null,
        provider,
        model,
        createdAt: now,
        updatedAt: now,
        lastMessagePreview: null,
      },
      getLatestAssistantText: () => undefined,
    },
    snapshot: {
      peek: () => ({ messageCount: opts.messageCount ?? 1, lastEventSeq: 0 }),
    },
    lifecycle: {
      waitForPersistenceIdle: mock(async () => undefined),
    },
    turns: {
      sendUserMessage: opts.sendUserMessage ?? mock(async () => undefined),
      activeTurnId: null,
    },
    settings: {
      configEvent: { config: { providerOptions: {} } },
      setConfig: mock(async () => undefined),
    },
  };
}

async function persistThread(
  sessionDb: SessionDb,
  workspace: string,
  providerOptions?: AgentConfig["providerOptions"],
) {
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
      providerOptions,
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

  test("readThread retains seeded history after later journal turns", async () => {
    const { workspace, sessionDb, threadJournal, host } = await makeHarness({
      registry: {
        readThreadSnapshot: () => ({
          feed: [
            { kind: "message", role: "user", text: "seeded context" },
            { kind: "message", role: "user", text: "follow-up" },
          ],
        }),
      },
    });
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
          itemId: "user-1",
          requestId: null,
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "user-1",
              type: "userMessage",
              content: [{ type: "input_text", text: "follow-up" }],
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

      const result = await host.readThread({ threadId: "thread-1" });
      expect(result.turns).toEqual([
        {
          id: "snapshot",
          status: "completed",
          items: [{ type: "user", text: "seeded context" }],
        },
        {
          id: "turn-1",
          status: "completed",
          items: [{ type: "user", text: "follow-up" }],
        },
      ]);
    } finally {
      await threadJournal.close();
      sessionDb.close();
    }
  });

  test("readThread falls back to persisted seed messages before snapshot or journal activity", async () => {
    const { workspace, sessionDb, threadJournal, host } = await makeHarness();
    try {
      await persistThread(sessionDb, workspace);

      const result = await host.readThread({ threadId: "thread-1" });
      expect(result.turns).toEqual([
        {
          id: "seed",
          status: "completed",
          items: [{ type: "user", text: "hello" }],
        },
      ]);
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

  test("forkThread seeds a new root thread in a managed worktree", async () => {
    const bindings = new Map<string, { runtime: ReturnType<typeof makeRuntime> }>();
    let sourceRuntime: ReturnType<typeof makeRuntime> | null = null;
    const created: Array<{
      cwd: string;
      provider: AgentConfig["provider"] | undefined;
      model: string | undefined;
      opts: { seedContext?: unknown; title?: string };
    }> = [];
    const sendUserMessage = mock(async () => undefined);
    const worktreePath = path.join(scratchRoots()[0] ?? "/tmp", "cowork-fork-worktree");
    const worktreeService = {
      createWorktree: mock(async () => ({
        path: worktreePath,
        repoRoot: "/repo",
        branchName: "cowork/fork/thread-one",
        baseRef: "HEAD",
        baseCommit: "abc123",
      })),
    };
    const registry = {
      sessionBindings: bindings,
      loadThreadBinding: (sessionId: string) => {
        if (sessionId === "thread-1" && sourceRuntime) return { runtime: sourceRuntime };
        return bindings.get(sessionId) ?? null;
      },
      createJsonRpcThreadSession: (
        cwd: string,
        provider?: AgentConfig["provider"],
        model?: string,
        opts: { seedContext?: unknown; title?: string } = {},
      ) => {
        created.push({ cwd, provider, model, opts });
        const runtime = makeRuntime({
          id: "fork-1",
          cwd,
          provider,
          model,
          title: opts.title,
          sendUserMessage,
        });
        bindings.set(runtime.id, { runtime });
        return runtime;
      },
    };
    const targetConfig = {
      projectCoworkDir: path.join(worktreePath, ".cowork"),
      providerOptions: { google: { thinkingConfig: { thinkingLevel: "high" } } },
    } as AgentConfig;
    const { workspace, sessionDb, threadJournal, host } = await makeHarness({
      registry,
      worktreeService,
      loadThreadSessionBootstrap: async () => ({ config: targetConfig, system: "target system" }),
    });
    try {
      await persistThread(sessionDb, workspace, {
        google: { thinkingConfig: { thinkingLevel: "medium" } },
      });
      sourceRuntime = makeRuntime({ id: "thread-1", cwd: workspace, title: "Thread One" });

      const result = await host.forkThread({
        threadId: "thread-1",
        environment: { type: "worktree", ref: "HEAD" },
        prompt: "continue here",
      });

      expect(worktreeService.createWorktree).toHaveBeenCalledWith({
        sourceCwd: workspace,
        titleHint: "Fork of Thread One",
        ref: "HEAD",
        branchName: undefined,
      });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        cwd: worktreePath,
        provider: "google",
        model: "gemini-3-flash-preview",
        opts: {
          title: "Fork of Thread One",
          system: "target system",
          config: {
            projectCoworkDir: path.join(worktreePath, ".cowork"),
            providerOptions: { google: { thinkingConfig: { thinkingLevel: "medium" } } },
          },
        },
      });
      expect(created[0]?.opts.seedContext).toEqual({
        messages: [{ role: "user", content: "hello" }],
        todos: [],
        harnessContext: null,
      });
      expect(sendUserMessage).toHaveBeenCalledWith("continue here");
      expect(result).toMatchObject({
        sourceThreadId: "thread-1",
        forked: true,
        queued: true,
        thread: { threadId: "fork-1", cwd: worktreePath },
        environment: {
          type: "worktree",
          cwd: worktreePath,
          branchName: "cowork/fork/thread-one",
          baseRef: "HEAD",
          baseCommit: "abc123",
        },
      });
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

  test("preserves desktop-only archive metadata when pinning a thread", async () => {
    const state = {
      workspaces: [],
      threads: [
        {
          id: "thread-1",
          sessionId: "thread-1",
          archived: true,
          archivedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    } as unknown as Awaited<ReturnType<WebDesktopServiceLike["loadState"]>>;
    const desktopService = {
      loadState: async () => state,
      saveState: async (next: unknown) => next as typeof state,
      listWorkspaces: async () => [],
      createOneOffChatWorkspace: async () => ({ name: "Chat", path: "/tmp/chat" }),
      getWorkspaceRoots: async () => [],
      resolveWorkspaceDirectory: async (workspacePath: string) => workspacePath,
    } satisfies WebDesktopServiceLike;
    const { workspace, sessionDb, threadJournal, host } = await makeHarness({ desktopService });
    try {
      await persistThread(sessionDb, workspace);
      await host.setPinned({ threadId: "thread-1", pinned: true });
      expect(sessionDb.getThreadMetadata("thread-1")).toMatchObject({
        pinned: true,
        archived: true,
        archivedAt: "2026-07-01T00:00:00.000Z",
      });
    } finally {
      await threadJournal.close();
      sessionDb.close();
    }
  });
});
