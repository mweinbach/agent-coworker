import type { StoreGet } from "../../store.helpers";
import { RUNTIME, resetModelStreamRuntime } from "../runtimeState";
import type { ThreadEventReducerContext } from "./context";

export function createWorkspaceStateHelpers(ctx: ThreadEventReducerContext) {
  const {
    deps: _deps,
    disposedWorkspaces,
    jsonRpcRouterCleanupByWorkspace,
    jsonRpcLifecycleCleanupByWorkspace,
    jsonRpcReconnectThreadsByWorkspace,
    jsonRpcThreadConnectPromises,
    threadStoreGettersByWorkspace,
  } = ctx;

  function isWorkspaceDisposed(workspaceId: string): boolean {
    return disposedWorkspaces.has(workspaceId);
  }

  function reactivateWorkspaceThreadEventState(workspaceId: string) {
    disposedWorkspaces.delete(workspaceId);
  }

  function hasPendingWorkspaceDefaultApply(threadId: string): boolean {
    return Boolean(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId));
  }

  function resetLiveModelStreamRuntime(threadId: string) {
    resetModelStreamRuntime(threadId);
  }

  function workspaceIdForThread(get: StoreGet, threadId: string): string | null {
    return get().threads.find((thread) => thread.id === threadId)?.workspaceId ?? null;
  }

  function rememberThreadStoreGet(workspaceId: string, get: StoreGet) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    threadStoreGettersByWorkspace.set(workspaceId, get);
  }

  function trackedThreadIdsForWorkspace(workspaceId: string, getOverride?: StoreGet): string[] {
    const trackedThreadIds = new Set<string>(
      jsonRpcReconnectThreadsByWorkspace.get(workspaceId) ?? [],
    );
    const get = getOverride ?? threadStoreGettersByWorkspace.get(workspaceId);
    const threads = get?.().threads ?? [];
    for (const thread of threads) {
      if (thread.workspaceId === workspaceId) {
        trackedThreadIds.add(thread.id);
      }
    }
    return [...trackedThreadIds];
  }

  function trackedWorkspaceIds(): string[] {
    const workspaceIds = new Set<string>();
    for (const workspaceId of jsonRpcRouterCleanupByWorkspace.keys()) {
      workspaceIds.add(workspaceId);
    }
    for (const workspaceId of jsonRpcLifecycleCleanupByWorkspace.keys()) {
      workspaceIds.add(workspaceId);
    }
    for (const workspaceId of jsonRpcReconnectThreadsByWorkspace.keys()) {
      workspaceIds.add(workspaceId);
    }
    for (const workspaceId of threadStoreGettersByWorkspace.keys()) {
      workspaceIds.add(workspaceId);
    }
    return [...workspaceIds];
  }

  function rememberThreadForReconnect(workspaceId: string, threadId: string) {
    if (isWorkspaceDisposed(workspaceId)) {
      return;
    }
    const threadIds = jsonRpcReconnectThreadsByWorkspace.get(workspaceId) ?? new Set<string>();
    threadIds.add(threadId);
    jsonRpcReconnectThreadsByWorkspace.set(workspaceId, threadIds);
  }

  function forgetThreadForReconnect(workspaceId: string, threadId: string) {
    const threadIds = jsonRpcReconnectThreadsByWorkspace.get(workspaceId);
    if (!threadIds) return;
    threadIds.delete(threadId);
    if (threadIds.size === 0) {
      jsonRpcReconnectThreadsByWorkspace.delete(workspaceId);
    }
  }

  function connectedThreadIdsForWorkspace(get: StoreGet, workspaceId: string): string[] {
    return get()
      .threads.filter((thread) => thread.workspaceId === workspaceId)
      .map((thread) => thread.id)
      .filter((threadId) => get().threadRuntimeById[threadId]?.connected);
  }

  function disposeWorkspaceThreadEventState(
    workspaceId: string,
    getOverride?: StoreGet,
    resetLiveModelStream?: (threadId: string) => void,
  ) {
    disposedWorkspaces.add(workspaceId);
    const routerCleanup = jsonRpcRouterCleanupByWorkspace.get(workspaceId);
    routerCleanup?.();
    jsonRpcRouterCleanupByWorkspace.delete(workspaceId);
    const lifecycleCleanup = jsonRpcLifecycleCleanupByWorkspace.get(workspaceId);
    lifecycleCleanup?.();
    jsonRpcLifecycleCleanupByWorkspace.delete(workspaceId);
    for (const threadId of trackedThreadIdsForWorkspace(workspaceId, getOverride)) {
      jsonRpcThreadConnectPromises.delete(threadId);
      resetLiveModelStream?.(threadId);
    }
    jsonRpcReconnectThreadsByWorkspace.delete(workspaceId);
    threadStoreGettersByWorkspace.delete(workspaceId);
  }

  function disposeAllThreadEventState(resetLiveModelStream?: (threadId: string) => void) {
    for (const workspaceId of trackedWorkspaceIds()) {
      disposeWorkspaceThreadEventState(workspaceId, undefined, resetLiveModelStream);
    }
  }

  return {
    isWorkspaceDisposed,
    reactivateWorkspaceThreadEventState,
    hasPendingWorkspaceDefaultApply,
    resetLiveModelStreamRuntime,
    workspaceIdForThread,
    rememberThreadStoreGet,
    trackedThreadIdsForWorkspace,
    trackedWorkspaceIds,
    rememberThreadForReconnect,
    forgetThreadForReconnect,
    connectedThreadIdsForWorkspace,
    disposeWorkspaceThreadEventState,
    disposeAllThreadEventState,
  };
}

export type WorkspaceStateHelpers = ReturnType<typeof createWorkspaceStateHelpers>;
