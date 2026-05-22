import type { StoreGet } from "../../store.helpers";
import type { ThreadEventReducerDeps } from "../threadEventReducerContext";

export type ThreadEventReducerContext = {
  deps: ThreadEventReducerDeps;
  jsonRpcRouterCleanupByWorkspace: Map<string, () => void>;
  jsonRpcLifecycleCleanupByWorkspace: Map<string, () => void>;
  jsonRpcReconnectThreadsByWorkspace: Map<string, Set<string>>;
  jsonRpcThreadConnectPromises: Map<string, Promise<void>>;
  threadStoreGettersByWorkspace: Map<string, StoreGet>;
  disposedWorkspaces: Set<string>;
};

export function createThreadEventReducerContext(
  deps: ThreadEventReducerDeps,
): ThreadEventReducerContext {
  return {
    deps,
    jsonRpcRouterCleanupByWorkspace: new Map(),
    jsonRpcLifecycleCleanupByWorkspace: new Map(),
    jsonRpcReconnectThreadsByWorkspace: new Map(),
    jsonRpcThreadConnectPromises: new Map(),
    threadStoreGettersByWorkspace: new Map(),
    disposedWorkspaces: new Set(),
  };
}
