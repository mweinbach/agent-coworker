import { describe, expect, test } from "bun:test";

import {
  buildRemoteThreadLoadPlan,
  buildWorkspaceLookup,
  loadBoundedRemoteThreads,
  ONE_OFF_CHAT_WORKSPACE_LIMIT,
  PROJECT_THREAD_LIMIT,
} from "../apps/mobile/src/features/cowork/remoteThreadBootstrap";
import type { WorkspaceSummary } from "../apps/mobile/src/features/cowork/protocolTypes";
import { useThreadStore } from "../apps/mobile/src/features/cowork/threadStore";

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
      { cwd: "/tmp/project-a", limit: PROJECT_THREAD_LIMIT },
      { cwd: "/tmp/project-b", limit: PROJECT_THREAD_LIMIT },
      { cwd: "/tmp/chats/chat-1" },
      { cwd: "/tmp/chats/chat-2" },
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
        };
      },
    };

    const threads = await loadBoundedRemoteThreads(client, [
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
    expect(threads.map((thread) => thread.id)).toEqual(["thread:/tmp/project-b"]);
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
