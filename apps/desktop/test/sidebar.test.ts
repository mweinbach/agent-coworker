import { describe, expect, test } from "bun:test";

import {
  applyWorkspaceOrder,
  formatSidebarRelativeAge,
  getVisibleSidebarThreads,
  groupStandardChatThreadsByWorkspace,
  reorderSidebarItemsById,
  shouldEmphasizeWorkspaceRow,
  swapSidebarItemsById,
} from "../src/ui/sidebarHelpers";

describe("desktop sidebar helpers", () => {
  test("keeps task-owned sessions out of standard chat groups", () => {
    const standard = {
      id: "chat-1",
      workspaceId: "ws-1",
      lastMessageAt: "2026-06-18T12:00:00.000Z",
    };
    const taskThread = {
      id: "task-session-1",
      workspaceId: "ws-1",
      lastMessageAt: "2026-06-18T13:00:00.000Z",
      taskId: "task-1",
    };

    expect(groupStandardChatThreadsByWorkspace([taskThread, standard]).get("ws-1")).toEqual([
      standard,
    ]);
  });

  test("keeps ordinary draft chats in standard chat groups while excluding task-owned drafts", () => {
    const activeChat = {
      id: "chat-1",
      workspaceId: "ws-1",
      lastMessageAt: "2026-06-18T12:00:00.000Z",
      draft: false,
    };
    const draftChat = {
      id: "draft-chat-1",
      workspaceId: "ws-1",
      lastMessageAt: "2026-06-18T13:00:00.000Z",
      draft: true,
    };
    const taskOwnedDraft = {
      id: "task-draft-1",
      workspaceId: "ws-1",
      lastMessageAt: "2026-06-18T14:00:00.000Z",
      draft: true,
      taskId: "task-1",
    };

    expect(
      groupStandardChatThreadsByWorkspace([activeChat, draftChat, taskOwnedDraft]).get("ws-1"),
    ).toEqual([draftChat, activeChat]);
  });

  test("caps visible threads at 5 by default and reports hidden overflow", () => {
    const threads = Array.from({ length: 12 }, (_, index) => ({ id: `thread-${index}` }));

    expect(getVisibleSidebarThreads(threads, false)).toEqual({
      visibleThreads: threads.slice(0, 5),
      hiddenThreadCount: 7,
    });
  });

  test("caps visible threads at 5 when explicit limit of 5 is provided", () => {
    const threads = Array.from({ length: 12 }, (_, index) => ({ id: `thread-${index}` }));

    expect(getVisibleSidebarThreads(threads, false, 5)).toEqual({
      visibleThreads: threads.slice(0, 5),
      hiddenThreadCount: 7,
    });
  });

  test("returns all threads when the overflow list is expanded", () => {
    const threads = Array.from({ length: 12 }, (_, index) => ({ id: `thread-${index}` }));

    expect(getVisibleSidebarThreads(threads, true)).toEqual({
      visibleThreads: threads,
      hiddenThreadCount: 0,
    });
  });

  test("reorders workspaces without re-sorting by recency", () => {
    const workspaces = [
      { id: "ws-1", name: "agent-coworker" },
      { id: "ws-2", name: "Workouts-iOS" },
      { id: "ws-3", name: "deep-research-knowledgebase" },
    ];

    expect(reorderSidebarItemsById(workspaces, "ws-3", "ws-1")).toEqual([
      { id: "ws-3", name: "deep-research-knowledgebase" },
      { id: "ws-1", name: "agent-coworker" },
      { id: "ws-2", name: "Workouts-iOS" },
    ]);
  });

  test("applies a workspace order by ids and appends omitted entries", () => {
    const workspaces = [
      { id: "ws-1", name: "agent-coworker" },
      { id: "ws-2", name: "Workouts-iOS" },
      { id: "ws-3", name: "deep-research-knowledgebase" },
    ];

    expect(applyWorkspaceOrder(workspaces, ["ws-3", "ws-1"])).toEqual([
      { id: "ws-3", name: "deep-research-knowledgebase" },
      { id: "ws-1", name: "agent-coworker" },
      { id: "ws-2", name: "Workouts-iOS" },
    ]);
  });

  test("returns the original reference when the applied workspace order is unchanged", () => {
    const workspaces = [
      { id: "ws-1", name: "agent-coworker" },
      { id: "ws-2", name: "Workouts-iOS" },
      { id: "ws-3", name: "deep-research-knowledgebase" },
    ];

    expect(applyWorkspaceOrder(workspaces, ["ws-1", "ws-2", "ws-3"])).toBe(workspaces);
  });

  test("swaps workspace positions by direction for keyboard reordering", () => {
    const workspaces = [
      { id: "ws-1", name: "agent-coworker" },
      { id: "ws-2", name: "Workouts-iOS" },
      { id: "ws-3", name: "deep-research-knowledgebase" },
    ];

    expect(swapSidebarItemsById(workspaces, "ws-2", "up")).toEqual([
      { id: "ws-2", name: "Workouts-iOS" },
      { id: "ws-1", name: "agent-coworker" },
      { id: "ws-3", name: "deep-research-knowledgebase" },
    ]);
    expect(swapSidebarItemsById(workspaces, "ws-2", "down")).toEqual([
      { id: "ws-1", name: "agent-coworker" },
      { id: "ws-3", name: "deep-research-knowledgebase" },
      { id: "ws-2", name: "Workouts-iOS" },
    ]);
  });

  test("does not swap workspaces past the list boundaries", () => {
    const workspaces = [
      { id: "ws-1", name: "agent-coworker" },
      { id: "ws-2", name: "Workouts-iOS" },
      { id: "ws-3", name: "deep-research-knowledgebase" },
    ];

    expect(swapSidebarItemsById(workspaces, "ws-1", "up")).toBe(workspaces);
    expect(swapSidebarItemsById(workspaces, "ws-3", "down")).toBe(workspaces);
  });

  test("formats sidebar ages at unit boundaries and rejects unparsable timestamps", () => {
    const now = Date.parse("2026-10-28T12:00:00.000Z");
    const realNow = Date.now;
    Date.now = () => now;
    const age = (elapsedMs: number) =>
      formatSidebarRelativeAge(new Date(now - elapsedMs).toISOString());
    try {
      expect(formatSidebarRelativeAge("")).toBe("");
      expect(formatSidebarRelativeAge("not-a-date")).toBe("");
      expect(formatSidebarRelativeAge("2026-13-40")).toBe("");
      expect(age(-86_400_000)).toBe("now");
      expect(age(0)).toBe("now");
      expect(age(59_999)).toBe("now");
      expect(age(60_000)).toBe("1m");
      expect(age(3_599_999)).toBe("59m");
      expect(age(3_600_000)).toBe("1h");
      expect(age(86_400_000 - 1)).toBe("23h");
      expect(age(86_400_000)).toBe("1d");
      expect(age(6 * 86_400_000)).toBe("6d");
      expect(age(7 * 86_400_000)).toBe("1w");
      expect(age(29 * 86_400_000)).toBe("4w");
      expect(age(30 * 86_400_000)).toBe("1mo");
      expect(age(364 * 86_400_000)).toBe("12mo");
      expect(age(365 * 86_400_000)).toBe("1y");
      expect(age(2 * 365 * 86_400_000 + 86_400_000)).toBe("2y");
    } finally {
      Date.now = realNow;
    }
  });

  test("does not emphasize the workspace row when one of its threads is selected", () => {
    expect(shouldEmphasizeWorkspaceRow(true, "thread-2", ["thread-1", "thread-2"])).toBe(false);
    expect(shouldEmphasizeWorkspaceRow(true, null, ["thread-1", "thread-2"])).toBe(true);
    expect(shouldEmphasizeWorkspaceRow(true, "thread-9", ["thread-1", "thread-2"])).toBe(true);
    expect(shouldEmphasizeWorkspaceRow(false, "thread-2", ["thread-1", "thread-2"])).toBe(false);
  });
});
