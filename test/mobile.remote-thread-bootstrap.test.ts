import { describe, expect, test } from "bun:test";

import type { CoworkJsonRpcClient } from "../apps/mobile/src/features/cowork/jsonRpcClient";
import type { CoworkThread, WorkspaceSummary } from "../apps/mobile/src/features/cowork/protocolTypes";
import {
  buildRemoteThreadLoadPlan,
  buildWorkspaceLookup,
  loadBoundedRemoteThreads,
  loadMoreOneOffChatWorkspaces,
  loadRemoteThreadsFromPlan,
  ONE_OFF_CHAT_WORKSPACE_LIMIT,
  PROJECT_THREAD_LIMIT,
} from "../apps/mobile/src/features/cowork/remoteThreadBootstrap";
import { useThreadStore } from "../apps/mobile/src/features/cowork/threadStore";

function makeThread(id: string, cwd: string): CoworkThread {
  const now = new Date().toISOString();
  return {
    id,
    title: id,
    preview: "",
    modelProvider: "opencode",
    model: "remote",
    cwd,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastEventSeq: 0,
    status: { type: "idle" },
  };
}

function makeWorkspace(
  id: string,
  path: string,
  kind: WorkspaceSummary["workspaceKind"] = "oneOffChat",
): WorkspaceSummary {
  return {
    id,
    name: id,
    path,
    workspaceKind: kind,
  };
}

function createStubClient(
  responses: Record<string, () => Promise<{ threads: CoworkThread[]; total: number }>>,
) {
  const calls: Array<{ cwd: string; ts: number }> = [];
  const client = {
    async requestThreadList(cwd?: string) {
      const path = cwd ?? "";
      calls.push({ cwd: path, ts: Date.now() });
      const responder = responses[path];
      if (!responder) {
        throw new Error(`unexpected requestThreadList for ${path}`);
      }
      return await responder();
    },
  } as unknown as Pick<CoworkJsonRpcClient, "requestThreadList">;
  return { client, calls };
}

describe("mobile remote thread bootstrap", () => {
  test("buildRemoteThreadLoadPlan requests projects first with limits, then one-off chats", () => {
    const workspaces: WorkspaceSummary[] = [
      {
        id: "project-b",
        name: "Project B",
        path: "/tmp/project-b",
        workspaceKind: "project",
        lastOpenedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "chat-2",
        name: "Chat Two",
        path: "/tmp/chats/chat-2",
        workspaceKind: "oneOffChat",
        lastOpenedAt: "2026-01-04T00:00:00.000Z",
      },
      {
        id: "project-a",
        name: "Project A",
        path: "/tmp/project-a",
        workspaceKind: "project",
        lastOpenedAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "chat-1",
        name: "Chat One",
        path: "/tmp/chats/chat-1",
        workspaceKind: "oneOffChat",
        lastOpenedAt: "2026-01-05T00:00:00.000Z",
      },
    ];

    expect(buildRemoteThreadLoadPlan(workspaces)).toEqual([
      { cwd: "/tmp/project-a", workspaceId: "project-a", limit: PROJECT_THREAD_LIMIT },
      { cwd: "/tmp/project-b", workspaceId: "project-b", limit: PROJECT_THREAD_LIMIT },
      { cwd: "/tmp/chats/chat-1", workspaceId: "chat-1" },
      { cwd: "/tmp/chats/chat-2", workspaceId: "chat-2" },
    ]);
  });

  test("buildRemoteThreadLoadPlan caps one-off chat workspace requests", () => {
    const workspaces: WorkspaceSummary[] = Array.from({ length: 12 }, (_, index) => ({
      id: `chat-${index}`,
      name: `Chat ${index}`,
      path: `/tmp/chats/chat-${index}`,
      workspaceKind: "oneOffChat" as const,
      lastOpenedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));

    const plan = buildRemoteThreadLoadPlan(workspaces);
    expect(plan).toHaveLength(ONE_OFF_CHAT_WORKSPACE_LIMIT);
    expect(plan.every((entry) => entry.limit === undefined)).toBe(true);
  });

  test("loadBoundedRemoteThreads keeps later workspace results when one list fails", async () => {
    const calls: Array<{ cwd?: string; limit?: number }> = [];
    const client = {
      async requestThreadList(cwd?: string, limit?: number) {
        calls.push({ cwd, limit });
        if (cwd === "/tmp/project-a") {
          throw new Error("stale workspace");
        }
        return {
          threads: [
            {
              id: `thread:${cwd}`,
              title: `Thread ${cwd}`,
              preview: "",
              modelProvider: "google" as const,
              model: "gemini",
              cwd: cwd ?? null,
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
              messageCount: 1,
              lastEventSeq: 1,
              status: { type: "loaded" as const },
            },
          ],
          total: 1,
        };
      },
    };

    const loaded = await loadBoundedRemoteThreads(client, [
      {
        id: "project-a",
        name: "Project A",
        path: "/tmp/project-a",
        workspaceKind: "project",
        lastOpenedAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "project-b",
        name: "Project B",
        path: "/tmp/project-b",
        workspaceKind: "project",
        lastOpenedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);

    expect(calls).toEqual([
      { cwd: "/tmp/project-a", limit: PROJECT_THREAD_LIMIT },
      { cwd: "/tmp/project-b", limit: PROJECT_THREAD_LIMIT },
    ]);
    expect(loaded.threads.map((thread) => thread.id)).toEqual(["thread:/tmp/project-b"]);
    expect(loaded.totalsByWorkspaceId).toEqual({ "project-b": 1 });
  });

  test("loadRemoteThreadsFromPlan runs requests in parallel rather than sequentially", async () => {
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const { client } = createStubClient({
      "/a": async () => {
        await delay(50);
        return { threads: [makeThread("t-a", "/a")], total: 1 };
      },
      "/b": async () => {
        await delay(50);
        return { threads: [makeThread("t-b", "/b")], total: 1 };
      },
      "/c": async () => {
        await delay(50);
        return { threads: [makeThread("t-c", "/c")], total: 1 };
      },
    });

    const start = Date.now();
    const result = await loadRemoteThreadsFromPlan(client, [
      { cwd: "/a", workspaceId: "a" },
      { cwd: "/b", workspaceId: "b" },
      { cwd: "/c", workspaceId: "c" },
    ]);
    const elapsed = Date.now() - start;

    expect(result.threads.map((t) => t.id).sort()).toEqual(["t-a", "t-b", "t-c"]);
    expect(elapsed).toBeLessThan(150);
  });

  test("loadRemoteThreadsFromPlan returns partial results when some entries fail", async () => {
    const { client } = createStubClient({
      "/ok": async () => ({ threads: [makeThread("t-ok", "/ok")], total: 1 }),
      "/bad": async () => {
        throw new Error("offline");
      },
    });

    const result = await loadRemoteThreadsFromPlan(client, [
      { cwd: "/ok", workspaceId: "ok" },
      { cwd: "/bad", workspaceId: "bad" },
    ]);

    expect(result.threads.map((t) => t.id)).toEqual(["t-ok"]);
    expect(result.totalsByWorkspaceId).toEqual({ ok: 1 });
  });

  test("loadRemoteThreadsFromPlan throws when every non-empty plan entry fails", async () => {
    const { client } = createStubClient({
      "/bad-1": async () => {
        throw new Error("timeout");
      },
      "/bad-2": async () => {
        throw new Error("timeout");
      },
    });

    await expect(
      loadRemoteThreadsFromPlan(client, [
        { cwd: "/bad-1", workspaceId: "1" },
        { cwd: "/bad-2", workspaceId: "2" },
      ]),
    ).rejects.toThrow();
  });

  test("loadRemoteThreadsFromPlan returns empty results without throwing for empty plans", async () => {
    const { client } = createStubClient({});
    const result = await loadRemoteThreadsFromPlan(client, []);
    expect(result.threads).toEqual([]);
    expect(result.totalsByWorkspaceId).toEqual({});
  });

  test("loadMoreOneOffChatWorkspaces propagates load errors instead of resolving with empty threads", async () => {
    const { client } = createStubClient({
      "/chat-1": async () => {
        throw new Error("JSON-RPC request timed out: thread/list");
      },
      "/chat-2": async () => {
        throw new Error("JSON-RPC request timed out: thread/list");
      },
    });
    const workspaces = [
      makeWorkspace("chat-1", "/chat-1"),
      makeWorkspace("chat-2", "/chat-2"),
    ];
    await expect(loadMoreOneOffChatWorkspaces(client, workspaces, 0, 5)).rejects.toThrow();
  });
});

describe("mobile thread store workspace classification", () => {
  test("syncRemoteThreads attaches workspace metadata from workspace records", () => {
    useThreadStore.setState({
      snapshots: {},
      threads: [],
      selectedThreadId: null,
      pendingRequests: {},
    });

    const workspaceByPath = buildWorkspaceLookup([
      {
        id: "project-1",
        name: "Alpha Project",
        path: "/tmp/alpha",
        workspaceKind: "project",
      },
      {
        id: "chat-1",
        name: "Standalone Chat",
        path: "/tmp/chats/chat-1",
        workspaceKind: "oneOffChat",
      },
    ]);

    useThreadStore.getState().syncRemoteThreads(
      [
        {
          id: "thread-project",
          title: "Project Thread",
          preview: "hello",
          modelProvider: "google",
          model: "gemini",
          cwd: "/tmp/alpha",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          messageCount: 1,
          lastEventSeq: 1,
          status: { type: "loaded" },
        },
        {
          id: "thread-chat",
          title: "Chat Thread",
          preview: "hey",
          modelProvider: "google",
          model: "gemini",
          cwd: "/tmp/chats/chat-1",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          messageCount: 1,
          lastEventSeq: 1,
          status: { type: "loaded" },
        },
      ],
      workspaceByPath,
    );

    const projectThread = useThreadStore.getState().getThread("thread-project");
    const chatThread = useThreadStore.getState().getThread("thread-chat");

    expect(projectThread).toMatchObject({
      workspaceId: "project-1",
      workspaceName: "Alpha Project",
      workspaceKind: "project",
    });
    expect(chatThread).toMatchObject({
      workspaceId: "chat-1",
      workspaceName: "Standalone Chat",
      workspaceKind: "oneOffChat",
    });
  });
});
