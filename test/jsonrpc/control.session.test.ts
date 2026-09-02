import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { MemoryStore } from "../../src/memoryStore";
import { AgentControl } from "../../src/server/agents/AgentControl";
import { createThreadRouteHandlers } from "../../src/server/jsonrpc/routes/thread";
import type { JsonRpcRouteContext, JsonRpcThread } from "../../src/server/jsonrpc/routes/types";
import { createWorkspaceRouteHandlers } from "../../src/server/jsonrpc/routes/workspace";
import { AgentSession } from "../../src/server/session/AgentSession";
import { startAgentServer } from "../../src/server/startServer";
import { WorkspaceBackupService } from "../../src/server/workspaceBackups";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";
import { connectJsonRpc, enableProjectBackups } from "./control.harness";

function persistedThread(
  sessionId: string,
  cwd: string,
  updatedAt: string,
  overrides: Partial<{
    parentSessionId: string | null;
    role: string | null;
  }> = {},
) {
  return {
    sessionId,
    sessionKind: "root",
    parentSessionId: overrides.parentSessionId ?? null,
    role: overrides.role ?? null,
    title: sessionId,
    titleSource: "manual",
    provider: "google",
    model: "gemini-3-flash-preview",
    workingDirectory: cwd,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    hasPendingAsk: false,
    hasPendingApproval: false,
    messageCount: 1,
    lastEventSeq: 1,
    executionState: null,
  };
}

function liveThread(
  id: string,
  cwd: string,
  updatedAt: string,
  overrides: Partial<{
    parentSessionId: string | null;
    role: string | null;
  }> = {},
) {
  return {
    id,
    read: {
      sessionKind: "root",
      parentSessionId: overrides.parentSessionId ?? null,
      role: overrides.role ?? null,
    },
    thread: {
      id,
      title: id,
      preview: "",
      modelProvider: "google",
      model: "gemini-3-flash-preview",
      cwd,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt,
      messageCount: 1,
      lastEventSeq: 1,
      hasPendingAsk: false,
      hasPendingApproval: false,
      status: { type: "loaded" },
    } satisfies JsonRpcThread,
  };
}

function threadFromRecord(record: ReturnType<typeof persistedThread>): JsonRpcThread {
  return {
    id: record.sessionId,
    title: record.title,
    preview: "",
    modelProvider: record.provider,
    model: record.model,
    cwd: record.workingDirectory,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messageCount,
    lastEventSeq: record.lastEventSeq,
    hasPendingAsk: record.hasPendingAsk,
    hasPendingApproval: record.hasPendingApproval,
    status: { type: "notLoaded" },
  };
}

function threadFromRuntime(runtime: ReturnType<typeof liveThread>): JsonRpcThread {
  return runtime.thread;
}

describe("server JSON-RPC control methods", () => {
  test("workspace bootstrap and thread list share ordinary chat filtering", async () => {
    const cwd = "/tmp/shared-chat-listing";
    const taskThreadIds = new Set(["task-root", "task-live"]);
    const state = [{ type: "config_updated", sessionId: "workspace-control" }];
    const persisted = [
      persistedThread("ordinary-old", cwd, "2026-01-01T00:00:00.000Z"),
      persistedThread("ordinary-new", cwd, "2026-01-03T00:00:00.000Z"),
      persistedThread("task-root", cwd, "2026-01-04T00:00:00.000Z"),
      persistedThread("child-parent", cwd, "2026-01-05T00:00:00.000Z", {
        parentSessionId: "ordinary-new",
      }),
      persistedThread("child-role", cwd, "2026-01-06T00:00:00.000Z", { role: "worker" }),
    ];
    const live = [
      liveThread("ordinary-live", cwd, "2026-01-07T00:00:00.000Z"),
      liveThread("task-live", cwd, "2026-01-08T00:00:00.000Z"),
      liveThread("child-live", cwd, "2026-01-09T00:00:00.000Z", {
        parentSessionId: "ordinary-new",
      }),
    ];
    const results: unknown[] = [];
    const context = {
      getConfig: () => ({ workingDirectory: cwd }),
      tasks: { isTaskThread: (threadId: string) => taskThreadIds.has(threadId) },
      threads: {
        listPersisted: () => persisted,
        listLiveRoot: () => live,
      },
      workspaceControl: {
        readState: async () => state,
      },
      jsonrpc: {
        sendResult: (_ws: unknown, _id: unknown, result: unknown) => results.push(result),
        sendError: (_ws: unknown, _id: unknown, error: unknown) => results.push({ error }),
      },
      utils: {
        resolveWorkspacePath: (params: Record<string, unknown>) => String(params.cwd ?? cwd),
        buildThreadFromRecord: threadFromRecord,
        buildThreadFromSession: threadFromRuntime,
        shouldIncludeThreadSummary: (summary: { messageCount?: number | null }) =>
          (summary.messageCount ?? 0) > 0,
      },
    } as unknown as JsonRpcRouteContext;

    await createWorkspaceRouteHandlers(context)["cowork/workspace/bootstrap"]?.({} as never, {
      id: 1,
      method: "cowork/workspace/bootstrap",
      params: { cwd },
    });
    await createThreadRouteHandlers(context)["thread/list"]?.({} as never, {
      id: 2,
      method: "thread/list",
      params: { cwd, offset: 1, limit: 1 },
    });

    expect(results[0]).toMatchObject({ state });
    expect((results[0] as { threads: JsonRpcThread[] }).threads.map((thread) => thread.id)).toEqual(
      ["ordinary-live", "ordinary-new", "ordinary-old"],
    );
    expect("total" in (results[0] as Record<string, unknown>)).toBe(false);
    expect(
      (results[1] as { threads: JsonRpcThread[]; total: number }).threads.map(
        (thread) => thread.id,
      ),
    ).toEqual(["ordinary-new"]);
    expect((results[1] as { total: number }).total).toBe(3);
  });

  test("session state read returns the workspace control config bundle", async () => {
    const tmpDir = await makeTmpProject();
    const realTmpDir = await fs.realpath(tmpDir);
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/state/read", {
        cwd: tmpDir,
      });

      expect(response.result.events.map((event: any) => event.type)).toEqual([
        "config_updated",
        "session_settings",
        "session_config",
      ]);
      const configUpdated = response.result.events[0];
      const sessionSettings = response.result.events[1];
      const sessionConfig = response.result.events[2];
      expect(configUpdated.config.provider).toBe("google");
      expect(configUpdated.config.workingDirectory).toBe(realTmpDir);
      expect(sessionSettings.enableMcp).toBe(true);
      expect(sessionConfig.config.defaultBackupsEnabled).toBe(false);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session state read defaults omitted cwd to the server working directory", async () => {
    const tmpDir = await makeTmpProject();
    const realTmpDir = await fs.realpath(tmpDir);
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/state/read", {});

      expect(response.result.events.map((event: any) => event.type)).toEqual([
        "config_updated",
        "session_settings",
        "session_config",
      ]);
      expect(response.result.events[0]?.config?.workingDirectory).toBe(realTmpDir);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session control methods return session-event event payloads", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const threadId = created.result.thread.id as string;

      const renamed = await rpc.request("cowork/session/title/set", {
        threadId,
        title: "Renamed session",
      });
      expect(renamed.result.event.type).toBe("session_info");
      expect(renamed.result.event.title).toBe("Renamed session");

      const modelUpdated = await rpc.request("cowork/session/model/set", {
        threadId,
        provider: "google",
        model: "gemini-3-flash-preview",
      });
      expect(modelUpdated.result.event.type).toBe("config_updated");
      expect(modelUpdated.result.event.config.model).toBe("gemini-3-flash-preview");

      const usageUpdated = await rpc.request("cowork/session/usageBudget/set", {
        threadId,
        stopAtUsd: null,
      });
      expect(usageUpdated.result.event.type).toBe("session_usage");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread fork JSON-RPC method creates a seeded local fork", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const sourceThreadId = created.result.thread.id as string;

      const forked = await rpc.request("thread/fork", {
        threadId: sourceThreadId,
        environment: { type: "local" },
        title: "Forked session",
      });
      expect(forked.result).toMatchObject({
        sourceThreadId,
        forked: true,
        queued: false,
        environment: { type: "local", cwd: forked.result.thread.cwd },
      });
      expect(forked.result.thread).toMatchObject({
        title: "Forked session",
        cwd: await fs.realpath(tmpDir),
      });
      expect(forked.result.thread.id).not.toBe(sourceThreadId);

      const listed = await rpc.request("thread/list", { cwd: tmpDir });
      expect(
        listed.result.threads.find(
          (thread: { id: string }) => thread.id === forked.result.thread.id,
        ),
      ).toMatchObject({ title: "Forked session" });
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread metadata JSON-RPC methods persist pinned and archived flags", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const threadId = created.result.thread.id as string;

      const pinned = await rpc.request("thread/pinned/set", { threadId, pinned: true });
      expect(pinned.result.thread).toMatchObject({ id: threadId, pinned: true, archived: false });

      const archived = await rpc.request("thread/archived/set", { threadId, archived: true });
      expect(archived.result.thread).toMatchObject({
        id: threadId,
        pinned: true,
        archived: true,
      });
      expect(archived.result.thread.archivedAt).toBeString();

      const listed = await rpc.request("thread/list", { cwd: tmpDir });
      expect(
        listed.result.threads.find((thread: { id: string }) => thread.id === threadId),
      ).toMatchObject({
        id: threadId,
        pinned: true,
        archived: true,
      });

      const db = new Database(path.join(tmpDir, ".cowork", "sessions.db"));
      try {
        const row = db
          .query("select pinned, archived from thread_metadata where thread_id = ?")
          .get(threadId) as { pinned: number; archived: number } | null;
        expect(row).toEqual({ pinned: 1, archived: 1 });
      } finally {
        db.close();
      }
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session delete rejects targets from another workspace", async () => {
    const tmpDir = await makeTmpProject();
    const otherTmpDir = await makeTmpProject();
    const primary = await startAgentServer(serverOpts(tmpDir));
    const secondary = await startAgentServer(
      serverOpts(otherTmpDir, {
        homedir: tmpDir,
      }),
    );
    let secondaryStopped = false;

    try {
      const rpc = await connectJsonRpc(primary.url);
      const otherRpc = await connectJsonRpc(secondary.url);
      const other = await otherRpc.request("thread/start", { cwd: otherTmpDir });
      const otherThreadId = other.result.thread.id;
      await otherRpc.request("cowork/session/title/set", {
        threadId: otherThreadId,
        title: "Other workspace",
      });
      otherRpc.close();
      await stopTestServer(secondary.server);
      secondaryStopped = true;

      const response = await rpc.request("cowork/session/delete", {
        cwd: tmpDir,
        targetSessionId: otherThreadId,
      });

      expect(response.error.message).toContain("outside the active workspace");
      expect(response.result).toBeUndefined();
      const db = new Database(path.join(tmpDir, ".cowork", "sessions.db"));
      try {
        const preserved = db
          .query("select count(*) as count from sessions where session_id = ?")
          .get(otherThreadId) as { count: number };
        expect(preserved.count).toBe(1);
      } finally {
        db.close();
      }
      rpc.close();
    } finally {
      if (!secondaryStopped) {
        await stopTestServer(secondary.server);
      }
      await stopTestServer(primary.server);
    }
  });

  test("session agent inspect returns the detailed inspect payload", async () => {
    const originalInspect = AgentControl.prototype.inspect;
    (AgentControl.prototype as any).inspect = async function inspectMock() {
      return {
        agent: {
          agentId: "child-1",
          parentSessionId: "thread-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          effectiveModel: "gpt-5.4",
          title: "child",
          provider: "openai",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          lifecycleState: "closed",
          executionState: "completed",
          busy: false,
          lastMessagePreview: "done",
        },
        latestAssistantText:
          'done\n\n<agent_report>{"status":"completed","summary":"Task done"}</agent_report>',
        parsedReport: {
          status: "completed",
          summary: "Task done",
        },
        reportRequired: true,
        reportFound: true,
        reportValid: true,
        reportBlockCount: 1,
        reportDiagnostic: null,
        sessionUsage: null,
        lastTurnUsage: null,
      };
    };

    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const threadId = created.result.thread.id as string;
      const response = await rpc.request("cowork/session/agent/inspect", {
        threadId,
        agentId: "child-1",
      });

      expect(response.result.event.agent.agentId).toBe("child-1");
      expect(response.result.event.latestAssistantText).toContain("done");
      expect(response.result.event.parsedReport.summary).toBe("Task done");
      rpc.close();
    } finally {
      (AgentControl.prototype as any).inspect = originalInspect;
      await stopTestServer(server);
    }
  });

  test("workspace file upload returns the saved path in a session event envelope", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/file/upload", {
        cwd: tmpDir,
        filename: "upload.txt",
        contentBase64: Buffer.from("hello upload").toString("base64"),
      });

      expect(response.result.event.type).toBe("file_uploaded");
      expect(response.result.event.filename).toBe("upload.txt");
      await expect(fs.readFile(response.result.event.path, "utf8")).resolves.toBe("hello upload");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace file upload rejects malformed base64 payloads", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/file/upload", {
        cwd: tmpDir,
        filename: "upload.txt",
        contentBase64: "!not-base64!",
      });

      expect(response.error.message).toBe("Invalid base64 file contents");
      await expect(fs.readdir(`${tmpDir}/User Uploads`)).rejects.toThrow();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace file upload rejects upload roots that resolve outside the workspace", async () => {
    const tmpDir = await makeTmpProject();
    const outsideDir = await fs.mkdtemp(path.join(path.dirname(tmpDir), "upload-escape-"));
    const uploadsDir = path.join(tmpDir, "User Uploads");
    await fs.symlink(outsideDir, uploadsDir, process.platform === "win32" ? "junction" : "dir");
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/file/upload", {
        cwd: tmpDir,
        filename: "upload.txt",
        contentBase64: Buffer.from("blocked upload").toString("base64"),
      });

      expect(response.error.message).toBe("Uploads directory resolves outside the workspace.");
      expect(response.result).toBeUndefined();
      await expect(fs.readFile(path.join(outsideDir, "upload.txt"), "utf8")).rejects.toThrow();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session model set returns the current config when the selected model is unchanged", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const thread = created.result.thread;
      const response = await rpc.request("cowork/session/model/set", {
        threadId: thread.id,
        provider: thread.modelProvider,
        model: thread.model,
      });

      expect(response.result.event.type).toBe("config_updated");
      expect(response.result.event.config.provider).toBe(thread.modelProvider);
      expect(response.result.event.config.model).toBe(thread.model);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session config set returns the current config event when the patch is a no-op", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const response = await rpc.request("cowork/session/config/set", {
        threadId: created.result.thread.id,
        config: {},
      });

      expect(response.result.event.type).toBe("session_config");
      expect(response.result.event.config.defaultBackupsEnabled).toBe(false);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session usage budget returns the emitted validation error instead of timing out", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const response = await rpc.request("cowork/session/usageBudget/set", {
        threadId: created.result.thread.id,
        warnAtUsd: 5,
        stopAtUsd: 1,
      });

      expect(response.error.message).toContain(
        "Warning threshold must be less than the hard-stop threshold",
      );
      expect(response.result).toBeUndefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
