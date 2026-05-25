import { describe, expect, test } from "bun:test";

import {
  buildThreadHomeViewModel,
  defaultThreadHomeUiState,
  getVisibleListSlice,
  normalizeHomeSectionOrder,
  reorderHomeSections,
  toggleHomeSectionOrder,
} from "../apps/mobile/src/features/cowork/threadHomeModel";
import type { MobileThreadSummary } from "../apps/mobile/src/features/cowork/threadStore";
import type { WorkspaceSummary } from "../apps/mobile/src/features/cowork/protocolTypes";

function makeThread(partial: Partial<MobileThreadSummary> & Pick<MobileThreadSummary, "id">) {
  return {
    title: partial.title ?? partial.id,
    preview: partial.preview ?? "Preview",
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00.000Z",
    cwd: partial.cwd ?? null,
    workspaceId: partial.workspaceId ?? null,
    workspaceName: partial.workspaceName ?? null,
    workspaceKind: partial.workspaceKind ?? null,
    feed: partial.feed ?? [],
    composerDraft: "",
    pendingPrompt: false,
    pendingServerRequest: null,
    ...partial,
  } satisfies MobileThreadSummary;
}

describe("thread home model", () => {
  test("normalizeHomeSectionOrder preserves unknown keys and fills missing sections", () => {
    expect(normalizeHomeSectionOrder(["projects"])).toEqual(["projects", "chats"]);
    expect(normalizeHomeSectionOrder(["chats", "projects", "chats"])).toEqual([
      "chats",
      "projects",
    ]);
  });

  test("reorderHomeSections moves a section without dropping keys", () => {
    expect(reorderHomeSections(["chats", "projects"], 0, 2)).toEqual(["projects", "chats"]);
    expect(reorderHomeSections(["projects", "chats"], 1, 0)).toEqual(["chats", "projects"]);
  });

  test("toggleHomeSectionOrder swaps chats and projects", () => {
    expect(toggleHomeSectionOrder(["chats", "projects"])).toEqual(["projects", "chats"]);
    expect(toggleHomeSectionOrder(["projects", "chats"])).toEqual(["chats", "projects"]);
  });

  test("getVisibleListSlice limits rows until showAll is enabled", () => {
    expect(getVisibleListSlice(["a", "b", "c", "d", "e", "f"], false, 5)).toEqual({
      visible: ["a", "b", "c", "d", "e"],
      hiddenCount: 1,
    });
    expect(getVisibleListSlice(["a", "b", "c", "d", "e", "f"], true, 5)).toEqual({
      visible: ["a", "b", "c", "d", "e", "f"],
      hiddenCount: 0,
    });
  });

  test("buildThreadHomeViewModel groups chats and projects with load-more hints", () => {
    const workspaces: WorkspaceSummary[] = [
      {
        id: "project-1",
        name: "Alpha",
        path: "/tmp/alpha",
        workspaceKind: "project",
      },
      {
        id: "chat-1",
        name: "Chat One",
        path: "/tmp/chats/1",
        workspaceKind: "oneOffChat",
      },
    ];
    const threads = [
      makeThread({
        id: "t-project",
        workspaceId: "project-1",
        workspaceKind: "project",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      makeThread({
        id: "t-chat",
        workspaceId: "chat-1",
        workspaceKind: "oneOffChat",
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
    ];

    const viewModel = buildThreadHomeViewModel({
      threads,
      workspaces,
      searchQuery: "",
      ui: {
        ...defaultThreadHomeUiState(),
        projectThreadTotals: { "project-1": 8 },
        projectThreadFetchLimits: { "project-1": 5 },
      },
    });

    expect(viewModel.chats.map((thread) => thread.id)).toEqual(["t-chat"]);
    expect(viewModel.projects[0]?.canLoadMoreFromServer).toBe(true);
    expect(viewModel.projects[0]?.serverTotal).toBe(8);
    expect(viewModel.sectionOrder).toEqual(["chats", "projects"]);
  });
});
