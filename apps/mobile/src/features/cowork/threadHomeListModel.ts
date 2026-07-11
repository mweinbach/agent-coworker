import type {
  HomeSectionKey,
  ThreadHomeProjectGroup,
  ThreadHomeViewModel,
} from "./threadHomeModel";
import type { MobileThreadSummary } from "./threadStore";

type PositionedRow = {
  key: string;
  revision: string;
  isFirst: boolean;
  isLast: boolean;
};

export type ThreadHomeListRow =
  | (PositionedRow & {
      kind: "chat";
      thread: MobileThreadSummary;
    })
  | (PositionedRow & {
      kind: "empty";
      label: string;
    })
  | (PositionedRow & {
      kind: "chat-load-more";
      label: string;
      loading: boolean;
      error: string | null;
    })
  | (PositionedRow & {
      kind: "project";
      workspaceId: string;
      workspaceName: string;
      count: number;
      expanded: boolean;
    })
  | (PositionedRow & {
      kind: "project-thread";
      workspaceId: string;
      thread: MobileThreadSummary;
    })
  | (PositionedRow & {
      kind: "project-load-more";
      workspaceId: string;
      label: string;
      loading: boolean;
      error: string | null;
    });

export type ThreadHomeListSection = {
  key: HomeSectionKey;
  title: string;
  orderIndex: number;
  data: ThreadHomeListRow[];
};

type BuildThreadHomeListSectionsInput = {
  viewModel: ThreadHomeViewModel;
  homeLoadPending: {
    chats: boolean;
    projects: Record<string, boolean>;
  };
  chatsError: string | null;
  projectErrors: Record<string, string>;
};

type UnpositionedRow<Row = ThreadHomeListRow> = Row extends ThreadHomeListRow
  ? Omit<Row, "isFirst" | "isLast">
  : never;

function positionRows(rows: UnpositionedRow[]): ThreadHomeListRow[] {
  return rows.map(
    (row, index): ThreadHomeListRow => ({
      ...row,
      isFirst: index === 0,
      isLast: index === rows.length - 1,
    }),
  );
}

function threadRevision(thread: MobileThreadSummary): string {
  return [
    thread.id,
    thread.title,
    thread.preview,
    thread.updatedAt ?? "",
    thread.pendingPrompt ? "pending" : "idle",
  ].join(":");
}

function chatsRows(
  viewModel: ThreadHomeViewModel,
  loading: boolean,
  error: string | null,
): ThreadHomeListRow[] {
  const rows: UnpositionedRow[] = viewModel.visibleChats.map((thread) => ({
    kind: "chat",
    key: `chat:${thread.id}`,
    revision: threadRevision(thread),
    thread,
  }));
  if (rows.length === 0) {
    rows.push({
      kind: "empty",
      key: "chat:empty",
      revision: "No chats yet",
      label: "No chats yet",
    });
  }

  const hasLoadMore = viewModel.hiddenChatCount > 0 || viewModel.canLoadMoreChatsFromServer;
  if (hasLoadMore || error) {
    const label = loading
      ? "Loading..."
      : viewModel.hiddenChatCount > 0
        ? viewModel.showAllChats
          ? "Show less"
          : `Show ${viewModel.hiddenChatCount} more`
        : hasLoadMore
          ? "Load more chats"
          : "Refresh";
    rows.push({
      kind: "chat-load-more",
      key: "chat:load-more",
      revision: `${label}:${loading}:${error ?? ""}`,
      label,
      loading,
      error,
    });
  }
  return positionRows(rows);
}

function projectRows(
  groups: ThreadHomeProjectGroup[],
  pending: Record<string, boolean>,
  errors: Record<string, string>,
): ThreadHomeListRow[] {
  const rows: UnpositionedRow[] = [];
  if (groups.length === 0) {
    return positionRows([
      {
        kind: "empty",
        key: "project:empty",
        revision: "No projects yet",
        label: "No projects yet",
      },
    ]);
  }

  for (const group of groups) {
    const workspaceId = group.workspace.id;
    const count = group.serverTotal ?? group.items.length;
    rows.push({
      kind: "project",
      key: `project:${workspaceId}`,
      revision: [group.workspace.name, count, group.expanded ? "expanded" : "collapsed"].join(":"),
      workspaceId,
      workspaceName: group.workspace.name,
      count,
      expanded: group.expanded,
    });
    if (!group.expanded) {
      continue;
    }
    if (group.visibleItems.length === 0) {
      rows.push({
        kind: "empty",
        key: `project:${workspaceId}:empty`,
        revision: "No threads yet",
        label: "No threads yet",
      });
    } else {
      for (const thread of group.visibleItems) {
        rows.push({
          kind: "project-thread",
          key: `project:${workspaceId}:thread:${thread.id}`,
          revision: threadRevision(thread),
          workspaceId,
          thread,
        });
      }
    }

    const hasLoadMore = group.hiddenLoadedCount > 0 || group.canLoadMoreFromServer;
    const error = errors[workspaceId] ?? null;
    if (hasLoadMore || error) {
      const loading = pending[workspaceId] === true;
      const label = loading
        ? "Loading..."
        : group.hiddenLoadedCount > 0
          ? group.showAllThreads
            ? "Show less"
            : `Show ${group.hiddenLoadedCount} more`
          : "Load more";
      rows.push({
        kind: "project-load-more",
        key: `project:${workspaceId}:load-more`,
        revision: `${label}:${loading}:${error ?? ""}`,
        workspaceId,
        label,
        loading,
        error,
      });
    }
  }
  return positionRows(rows);
}

export function buildThreadHomeListSections({
  viewModel,
  homeLoadPending,
  chatsError,
  projectErrors,
}: BuildThreadHomeListSectionsInput): ThreadHomeListSection[] {
  if (viewModel.isEmpty) {
    return [];
  }
  const sectionsByKey: Record<HomeSectionKey, ThreadHomeListSection> = {
    chats: {
      key: "chats",
      title: "Chats",
      orderIndex: 0,
      data: chatsRows(viewModel, homeLoadPending.chats, chatsError),
    },
    projects: {
      key: "projects",
      title: "Projects",
      orderIndex: 0,
      data: projectRows(viewModel.projects, homeLoadPending.projects, projectErrors),
    },
  };
  return viewModel.sectionOrder.map((key, orderIndex) => ({
    ...sectionsByKey[key],
    orderIndex,
  }));
}

export function threadHomeListRowCount(sections: readonly ThreadHomeListSection[]): number {
  return sections.reduce((total, section) => total + section.data.length, 0);
}
