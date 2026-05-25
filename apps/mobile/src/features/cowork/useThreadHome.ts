import { useCallback, useMemo, useState } from "react";

import {
  buildWorkspaceLookup,
  loadBoundedRemoteThreads,
  loadMoreOneOffChatWorkspaces,
  loadMoreProjectThreads,
  PROJECT_THREAD_LIMIT,
} from "./remoteThreadBootstrap";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import {
  buildThreadHomeViewModel,
  defaultThreadHomeUiState,
  type HomeSectionKey,
} from "./threadHomeModel";
import { useThreadStore } from "./threadStore";
import { useWorkspaceStore } from "./workspaceStore";

export function useThreadHome() {
  const threads = useThreadStore((state) => state.threads);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const sectionOrder = useThreadStore((state) => state.sectionOrder);
  const sectionsOpen = useThreadStore((state) => state.sectionsOpen);
  const showAllChats = useThreadStore((state) => state.showAllChats);
  const expandedWorkspaceIds = useThreadStore((state) => state.expandedWorkspaceIds);
  const expandedProjectThreadLists = useThreadStore((state) => state.expandedProjectThreadLists);
  const projectThreadFetchLimits = useThreadStore((state) => state.projectThreadFetchLimits);
  const projectThreadTotals = useThreadStore((state) => state.projectThreadTotals);
  const oneOffChatWorkspaceLoadLimit = useThreadStore(
    (state) => state.oneOffChatWorkspaceLoadLimit,
  );
  const homeLoadPending = useThreadStore((state) => state.homeLoadPending);
  const syncRemoteThreads = useThreadStore((state) => state.syncRemoteThreads);
  const toggleSectionOpen = useThreadStore((state) => state.toggleSectionOpen);
  const toggleSectionOrder = useThreadStore((state) => state.toggleSectionOrder);
  const toggleShowAllChats = useThreadStore((state) => state.toggleShowAllChats);
  const toggleWorkspaceExpanded = useThreadStore((state) => state.toggleWorkspaceExpanded);
  const toggleProjectThreadListExpanded = useThreadStore(
    (state) => state.toggleProjectThreadListExpanded,
  );
  const expandWorkspace = useThreadStore((state) => state.expandWorkspace);
  const setProjectThreadTotals = useThreadStore((state) => state.setProjectThreadTotals);
  const setProjectThreadFetchLimit = useThreadStore((state) => state.setProjectThreadFetchLimit);
  const setOneOffChatWorkspaceLoadLimit = useThreadStore(
    (state) => state.setOneOffChatWorkspaceLoadLimit,
  );
  const setHomeLoadPending = useThreadStore((state) => state.setHomeLoadPending);

  const [searchQuery, setSearchQuery] = useState("");

  const uiState = useMemo(
    () => ({
      ...defaultThreadHomeUiState(),
      sectionOrder,
      sectionsOpen,
      showAllChats,
      expandedWorkspaceIds,
      expandedProjectThreadLists,
      projectThreadFetchLimits,
      projectThreadTotals,
      oneOffChatWorkspaceLoadLimit,
    }),
    [
      sectionOrder,
      sectionsOpen,
      showAllChats,
      expandedWorkspaceIds,
      expandedProjectThreadLists,
      projectThreadFetchLimits,
      projectThreadTotals,
      oneOffChatWorkspaceLoadLimit,
    ],
  );

  const viewModel = useMemo(
    () =>
      buildThreadHomeViewModel({
        threads,
        workspaces,
        searchQuery,
        ui: uiState,
      }),
    [threads, workspaces, searchQuery, uiState],
  );

  const loadMoreChats = useCallback(async () => {
    const client = getActiveCoworkJsonRpcClient();
    if (!client || !viewModel.canLoadMoreChatsFromServer) {
      if (viewModel.hiddenChatCount > 0) {
        toggleShowAllChats();
      }
      return;
    }

    if (viewModel.hiddenChatCount > 0) {
      toggleShowAllChats();
      return;
    }

    setHomeLoadPending({ chats: true });
    try {
      const result = await loadMoreOneOffChatWorkspaces(
        client,
        workspaces,
        oneOffChatWorkspaceLoadLimit,
      );
      setOneOffChatWorkspaceLoadLimit(result.nextLimit);
      syncRemoteThreads(result.threads, buildWorkspaceLookup(workspaces));
      setProjectThreadTotals(result.totalsByWorkspaceId);
      toggleShowAllChats();
    } finally {
      setHomeLoadPending({ chats: false });
    }
  }, [
    oneOffChatWorkspaceLoadLimit,
    setHomeLoadPending,
    setOneOffChatWorkspaceLoadLimit,
    setProjectThreadTotals,
    syncRemoteThreads,
    toggleShowAllChats,
    viewModel.canLoadMoreChatsFromServer,
    viewModel.hiddenChatCount,
    workspaces,
  ]);

  const loadMoreProject = useCallback(
    async (workspaceId: string) => {
      const group = viewModel.projects.find((entry) => entry.workspace.id === workspaceId);
      if (!group) {
        return;
      }

      if (group.hiddenLoadedCount > 0) {
        toggleProjectThreadListExpanded(workspaceId);
        return;
      }

      if (!group.canLoadMoreFromServer) {
        return;
      }

      const client = getActiveCoworkJsonRpcClient();
      if (!client) {
        return;
      }

      const currentLimit = projectThreadFetchLimits[workspaceId] ?? PROJECT_THREAD_LIMIT;
      setHomeLoadPending({ projectWorkspaceId: workspaceId, projectPending: true });
      try {
        const result = await loadMoreProjectThreads(client, group.workspace, currentLimit);
        setProjectThreadFetchLimit(workspaceId, result.nextLimit);
        setProjectThreadTotals({ [workspaceId]: result.total });
        syncRemoteThreads(result.threads, buildWorkspaceLookup(workspaces));
        toggleProjectThreadListExpanded(workspaceId);
      } finally {
        setHomeLoadPending({ projectWorkspaceId: workspaceId, projectPending: false });
      }
    },
    [
      projectThreadFetchLimits,
      setHomeLoadPending,
      setProjectThreadFetchLimit,
      setProjectThreadTotals,
      syncRemoteThreads,
      toggleProjectThreadListExpanded,
      viewModel.projects,
      workspaces,
    ],
  );

  const refreshRemoteThreads = useCallback(async () => {
    const client = getActiveCoworkJsonRpcClient();
    if (!client || workspaces.length === 0) {
      return;
    }
    const loaded = await loadBoundedRemoteThreads(client, workspaces, {
      oneOffChatWorkspaceLimit: oneOffChatWorkspaceLoadLimit,
      projectThreadLimitsByWorkspaceId: projectThreadFetchLimits,
    });
    syncRemoteThreads(loaded.threads, buildWorkspaceLookup(workspaces));
    setProjectThreadTotals(loaded.totalsByWorkspaceId);
  }, [
    oneOffChatWorkspaceLoadLimit,
    projectThreadFetchLimits,
    setProjectThreadTotals,
    syncRemoteThreads,
    workspaces,
  ]);

  const toggleSection = useCallback(
    (section: HomeSectionKey) => {
      toggleSectionOpen(section);
    },
    [toggleSectionOpen],
  );

  return {
    viewModel,
    searchQuery,
    setSearchQuery,
    homeLoadPending,
    toggleSection,
    toggleSectionOrder,
    toggleWorkspaceExpanded,
    expandWorkspace,
    loadMoreChats,
    loadMoreProject,
    refreshRemoteThreads,
    toggleShowAllChats,
    toggleProjectThreadListExpanded,
  };
}
