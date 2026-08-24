import { describe, expect, test } from "bun:test";
import type { WorkspaceSummary } from "../apps/mobile/src/features/cowork/protocolTypes";
import {
  buildThreadHomeListSections,
  describeThreadHomeAttention,
} from "../apps/mobile/src/features/cowork/threadHomeListModel";
import {
  buildThreadHomeViewModel,
  defaultThreadHomeUiState,
  getVisibleListSlice,
  normalizeHomeSectionOrder,
  reorderHomeSections,
  toggleHomeSectionOrder,
} from "../apps/mobile/src/features/cowork/threadHomeModel";
import type { MobileThreadSummary } from "../apps/mobile/src/features/cowork/threadStore";

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
    composerAttachments: [],
    composerSubmission: null,
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

  test("keeps durable local drafts and orphaned conversations discoverable on home", () => {
    const localDraft = makeThread({
      id: "draft-offline-1",
      title: "Offline conversation",
      workspaceKind: null,
      composerDraft: "recover this after the app restarts",
    });
    const orphanedRemote = makeThread({
      id: "orphaned-remote-1",
      title: "Recovered desktop conversation",
      workspaceKind: null,
    });
    const viewModel = buildThreadHomeViewModel({
      threads: [localDraft, orphanedRemote],
      workspaces: [],
      searchQuery: "",
      ui: defaultThreadHomeUiState(),
    });

    expect(viewModel.visibleChats.map((thread) => thread.id)).toEqual([
      "draft-offline-1",
      "orphaned-remote-1",
    ]);
    expect(viewModel.isEmpty).toBe(false);

    const draftSearch = buildThreadHomeViewModel({
      threads: [localDraft],
      workspaces: [],
      searchQuery: "recover this",
      ui: defaultThreadHomeUiState(),
    });
    expect(draftSearch.visibleChats.map((thread) => thread.id)).toEqual(["draft-offline-1"]);
  });

  test("prioritizes approvals, failed sends, sending, and durable drafts on home rows", () => {
    const thread = makeThread({
      id: "attention-chat",
      composerDraft: "an unsent draft",
      composerSubmission: {
        clientMessageId: "stable-message-1",
        text: "an unsent draft",
        attachments: [],
        status: "failed",
        error: "Connection interrupted",
      },
      pendingPrompt: true,
    });

    expect(describeThreadHomeAttention(thread)).toEqual({
      label: "Needs response",
      tone: "warning",
    });
    expect(describeThreadHomeAttention({ ...thread, pendingPrompt: false })).toEqual({
      label: "Send failed",
      tone: "danger",
    });
    expect(
      describeThreadHomeAttention({
        ...thread,
        pendingPrompt: false,
        composerSubmission: { ...thread.composerSubmission!, status: "submitting", error: null },
      }),
    ).toEqual({ label: "Sending", tone: "primary" });
    expect(
      describeThreadHomeAttention({
        ...thread,
        pendingPrompt: false,
        composerSubmission: null,
      }),
    ).toEqual({ label: "Draft", tone: "primary" });
    expect(
      describeThreadHomeAttention({
        ...thread,
        pendingPrompt: false,
        composerSubmission: null,
        composerDraft: "",
      }),
    ).toBeNull();
  });

  test("invalidates only changed home rows when drafts or submission state change", () => {
    function rowRevisions(threads: MobileThreadSummary[]): Map<string, string> {
      const viewModel = buildThreadHomeViewModel({
        threads,
        workspaces: [],
        searchQuery: "",
        ui: defaultThreadHomeUiState(),
      });
      const sections = buildThreadHomeListSections({
        viewModel,
        homeLoadPending: { chats: false, projects: {} },
        chatsError: null,
        projectErrors: {},
      });
      return new Map(
        sections.flatMap((section) => section.data.map((row) => [row.key, row.revision])),
      );
    }

    const changing = makeThread({ id: "changing-chat", workspaceKind: "oneOffChat" });
    const stable = makeThread({ id: "stable-chat", workspaceKind: "oneOffChat" });
    const idle = rowRevisions([changing, stable]);
    const drafted = rowRevisions([{ ...changing, composerDraft: "saved draft" }, stable]);
    const failed = rowRevisions([
      {
        ...changing,
        composerDraft: "saved draft",
        composerSubmission: {
          clientMessageId: "message-1",
          text: "saved draft",
          attachments: [],
          status: "failed",
          error: "offline",
        },
      },
      stable,
    ]);

    expect(drafted.get("chat:changing-chat")).not.toBe(idle.get("chat:changing-chat"));
    expect(failed.get("chat:changing-chat")).not.toBe(drafted.get("chat:changing-chat"));
    expect(failed.get("chat:stable-chat")).toBe(idle.get("chat:stable-chat"));
  });
});
