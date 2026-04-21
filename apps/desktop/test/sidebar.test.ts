import { describe, expect, test } from "bun:test";

import {
  applyWorkspaceOrder,
  getVisibleSidebarThreads,
  reorderSidebarItemsById,
  shouldEmphasizeWorkspaceRow,
  swapSidebarItemsById,
} from "../src/ui/sidebarHelpers";

describe("desktop sidebar helpers", () => {
  test("caps visible threads at 10 by default and reports hidden overflow", () => {
    const threads = Array.from({ length: 12 }, (_, index) => ({ id: `thread-${index}` }));

    expect(getVisibleSidebarThreads(threads, false)).toEqual({
      visibleThreads: threads.slice(0, 10),
      hiddenThreadCount: 2,
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

  test("does not emphasize the workspace row when one of its threads is selected", () => {
    expect(shouldEmphasizeWorkspaceRow(true, "thread-2", ["thread-1", "thread-2"])).toBe(false);
    expect(shouldEmphasizeWorkspaceRow(true, null, ["thread-1", "thread-2"])).toBe(true);
    expect(shouldEmphasizeWorkspaceRow(true, "thread-9", ["thread-1", "thread-2"])).toBe(true);
    expect(shouldEmphasizeWorkspaceRow(false, "thread-2", ["thread-1", "thread-2"])).toBe(false);
  });
});
