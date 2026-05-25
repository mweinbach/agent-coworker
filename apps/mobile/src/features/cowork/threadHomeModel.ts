import type { MobileThreadSummary } from "./threadStore";
import type { WorkspaceSummary } from "./protocolTypes";

export const HOME_SECTION_KEYS = ["chats", "projects"] as const;
export type HomeSectionKey = (typeof HOME_SECTION_KEYS)[number];

export const INITIAL_VISIBLE_CHAT_COUNT = 5;
export const INITIAL_VISIBLE_PROJECT_THREAD_COUNT = 5;
export const PROJECT_THREAD_PAGE_SIZE = 5;
export const ONE_OFF_CHAT_WORKSPACE_PAGE_SIZE = 10;

export type ThreadHomeSectionsOpen = {
  chats: boolean;
  projects: boolean;
};

export type ThreadHomeUiState = {
  sectionOrder: HomeSectionKey[];
  sectionsOpen: ThreadHomeSectionsOpen;
  showAllChats: boolean;
  expandedWorkspaceIds: Record<string, true>;
  expandedProjectThreadLists: Record<string, true>;
  projectThreadFetchLimits: Record<string, number>;
  projectThreadTotals: Record<string, number>;
  oneOffChatWorkspaceLoadLimit: number;
};

export type ThreadHomeProjectGroup = {
  workspace: WorkspaceSummary;
  items: MobileThreadSummary[];
  expanded: boolean;
  showAllThreads: boolean;
  visibleItems: MobileThreadSummary[];
  hiddenLoadedCount: number;
  canLoadMoreFromServer: boolean;
  serverTotal: number | null;
};

export type ThreadHomeViewModel = {
  chats: MobileThreadSummary[];
  visibleChats: MobileThreadSummary[];
  hiddenChatCount: number;
  canLoadMoreChatsFromServer: boolean;
  totalOneOffChatWorkspaces: number;
  projects: ThreadHomeProjectGroup[];
  sectionOrder: HomeSectionKey[];
  sectionsOpen: ThreadHomeSectionsOpen;
  showAllChats: boolean;
  isEmpty: boolean;
  searchQuery: string;
};

export function normalizeHomeSectionOrder(value?: readonly unknown[] | null): HomeSectionKey[] {
  const seen = new Set<HomeSectionKey>();
  const ordered: HomeSectionKey[] = [];

  for (const entry of value ?? []) {
    if (entry !== "chats" && entry !== "projects") {
      continue;
    }
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    ordered.push(entry);
  }

  for (const key of HOME_SECTION_KEYS) {
    if (!seen.has(key)) {
      ordered.push(key);
    }
  }

  return ordered;
}

export function defaultThreadHomeUiState(): ThreadHomeUiState {
  return {
    sectionOrder: ["chats", "projects"],
    sectionsOpen: { chats: true, projects: true },
    showAllChats: false,
    expandedWorkspaceIds: {},
    expandedProjectThreadLists: {},
    projectThreadFetchLimits: {},
    projectThreadTotals: {},
    oneOffChatWorkspaceLoadLimit: ONE_OFF_CHAT_WORKSPACE_PAGE_SIZE,
  };
}

function sortThreadsByUpdatedAt(threads: MobileThreadSummary[]): MobileThreadSummary[] {
  return [...threads].sort((left, right) => {
    const leftTs = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTs = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    return rightTs - leftTs;
  });
}

function sortWorkspacesByLastOpened(workspaces: WorkspaceSummary[]): WorkspaceSummary[] {
  return [...workspaces].sort((left, right) =>
    (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? ""),
  );
}

export function formatThreadRelativeAge(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}

export function getVisibleListSlice<T>(
  items: T[],
  showAll: boolean,
  limit: number,
): { visible: T[]; hiddenCount: number } {
  const visible = showAll ? items : items.slice(0, limit);
  return {
    visible,
    hiddenCount: Math.max(0, items.length - visible.length),
  };
}

type BuildThreadHomeViewModelInput = {
  threads: MobileThreadSummary[];
  workspaces: WorkspaceSummary[];
  searchQuery: string;
  ui: ThreadHomeUiState;
};

export function buildThreadHomeViewModel({
  threads,
  workspaces,
  searchQuery,
  ui,
}: BuildThreadHomeViewModelInput): ThreadHomeViewModel {
  const query = searchQuery.trim().toLowerCase();
  const filteredThreads = query
    ? threads.filter(
        (thread) =>
          thread.title.toLowerCase().includes(query) ||
          thread.preview.toLowerCase().includes(query),
      )
    : threads;

  const chatList = sortThreadsByUpdatedAt(
    filteredThreads.filter((thread) => thread.workspaceKind === "oneOffChat"),
  );

  const oneOffWorkspaces = sortWorkspacesByLastOpened(
    workspaces.filter((workspace) => workspace.workspaceKind === "oneOffChat"),
  );
  const loadedOneOffWorkspaceCount = Math.min(
    ui.oneOffChatWorkspaceLoadLimit,
    oneOffWorkspaces.length,
  );
  const canLoadMoreChatsFromServer = oneOffWorkspaces.length > loadedOneOffWorkspaceCount;

  const { visible: visibleChats, hiddenCount: hiddenChatCount } = getVisibleListSlice(
    chatList,
    ui.showAllChats,
    INITIAL_VISIBLE_CHAT_COUNT,
  );

  const projectWorkspaces = sortWorkspacesByLastOpened(
    workspaces.filter((workspace) => workspace.workspaceKind !== "oneOffChat"),
  );

  const threadsByWorkspaceId = new Map<string, MobileThreadSummary[]>();
  for (const thread of filteredThreads) {
    if (thread.workspaceKind === "oneOffChat" || !thread.workspaceId) {
      continue;
    }
    const bucket = threadsByWorkspaceId.get(thread.workspaceId);
    if (bucket) {
      bucket.push(thread);
    } else {
      threadsByWorkspaceId.set(thread.workspaceId, [thread]);
    }
  }

  const projects: ThreadHomeProjectGroup[] = projectWorkspaces.map((workspace) => {
    const items = sortThreadsByUpdatedAt(threadsByWorkspaceId.get(workspace.id) ?? []);
    const expanded = ui.expandedWorkspaceIds[workspace.id] === true;
    const showAllThreads = ui.expandedProjectThreadLists[workspace.id] === true;
    const { visible: visibleItems, hiddenCount: hiddenLoadedCount } = getVisibleListSlice(
      items,
      showAllThreads,
      INITIAL_VISIBLE_PROJECT_THREAD_COUNT,
    );
    const serverTotal = ui.projectThreadTotals[workspace.id] ?? null;
    const fetchedLimit = ui.projectThreadFetchLimits[workspace.id] ?? PROJECT_THREAD_PAGE_SIZE;
    const canLoadMoreFromServer =
      serverTotal !== null ? items.length < serverTotal : items.length >= fetchedLimit;

    return {
      workspace,
      items,
      expanded,
      showAllThreads,
      visibleItems,
      hiddenLoadedCount,
      canLoadMoreFromServer,
      serverTotal,
    };
  });

  return {
    chats: chatList,
    visibleChats,
    hiddenChatCount,
    canLoadMoreChatsFromServer,
    totalOneOffChatWorkspaces: oneOffWorkspaces.length,
    projects,
    sectionOrder: normalizeHomeSectionOrder(ui.sectionOrder),
    sectionsOpen: ui.sectionsOpen,
    showAllChats: ui.showAllChats,
    isEmpty: chatList.length === 0 && projects.every((group) => group.items.length === 0),
    searchQuery,
  };
}

export function toggleHomeSectionOrder(current: HomeSectionKey[]): HomeSectionKey[] {
  const normalized = normalizeHomeSectionOrder(current);
  return normalized[0] === "chats" ? ["projects", "chats"] : ["chats", "projects"];
}
