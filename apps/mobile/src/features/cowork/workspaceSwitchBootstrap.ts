import {
  captureWorkspaceRequest,
  isStaleWorkspaceRequestError,
  StaleWorkspaceRequestError,
} from "./controlRpc";
import type { CoworkThreadListResult } from "./protocolTypes";
import { buildWorkspaceLookup } from "./remoteThreadBootstrap";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useThreadStore } from "./threadStore";
import { clearWorkspaceDataStores, refreshWorkspaceBoundStores } from "./workspaceBootstrap";
import { useWorkspaceStore } from "./workspaceStore";

type BootstrapWorkspaceSwitchSessionOptions = {
  client: {
    initialize: () => Promise<void>;
    requestThreadList: () => Promise<CoworkThreadListResult>;
  };
  clearThreads: () => void;
  hydrateThreads: (threads: CoworkThreadListResult["threads"]) => void;
  refreshWorkspaceBoundStores: () => Promise<void>;
  isCurrent?: () => boolean;
};

export async function bootstrapWorkspaceSwitchSession(
  options: BootstrapWorkspaceSwitchSessionOptions,
): Promise<void> {
  options.clearThreads();
  await options.client.initialize();
  if (options.isCurrent?.() === false) throw new StaleWorkspaceRequestError();
  const list = await options.client.requestThreadList();
  if (options.isCurrent?.() === false) throw new StaleWorkspaceRequestError();
  options.hydrateThreads(list.threads);
  await options.refreshWorkspaceBoundStores();
  if (options.isCurrent?.() === false) throw new StaleWorkspaceRequestError();
}

let workspaceSwitchInFlight: Promise<void> | null = null;

export function switchMobileWorkspace(workspaceId: string): Promise<void> {
  if (workspaceSwitchInFlight) return workspaceSwitchInFlight;
  const store = useWorkspaceStore.getState();
  if (store.activeWorkspaceId === workspaceId && !store.switchIncomplete) return Promise.resolve();
  const client = getActiveCoworkJsonRpcClient();
  if (!client) {
    const error = new Error("No active desktop connection.");
    useWorkspaceStore.setState({ error: error.message });
    return Promise.reject(error);
  }

  useWorkspaceStore.setState({ switchingWorkspaceId: workspaceId, error: null });
  const switching = (async () => {
    try {
      if (store.activeWorkspaceId !== workspaceId) {
        await store.switchWorkspace(workspaceId);
      } else {
        client.resetTransportSession("Retrying workspace initialization.");
      }
      if (getActiveCoworkJsonRpcClient() !== client) throw new StaleWorkspaceRequestError();
      const isCurrent = captureWorkspaceRequest(client);
      clearWorkspaceDataStores();
      useWorkspaceStore.setState({ controlSnapshot: null });
      await bootstrapWorkspaceSwitchSession({
        client,
        clearThreads: () => useThreadStore.getState().clearPendingRequestsOnDisconnect(),
        hydrateThreads: (threads) =>
          useThreadStore
            .getState()
            .syncRemoteThreads(
              threads,
              buildWorkspaceLookup(useWorkspaceStore.getState().workspaces),
            ),
        refreshWorkspaceBoundStores,
        isCurrent,
      });
      const error = useWorkspaceStore.getState().error;
      if (error) throw new Error(error);
      useWorkspaceStore.setState({ switchIncomplete: false, error: null });
    } catch (error) {
      if (!isStaleWorkspaceRequestError(error) && getActiveCoworkJsonRpcClient() === client) {
        useWorkspaceStore.setState({
          error: error instanceof Error ? error.message : String(error),
          switchIncomplete: useWorkspaceStore.getState().activeWorkspaceId === workspaceId,
        });
      }
      throw error;
    } finally {
      if (useWorkspaceStore.getState().switchingWorkspaceId === workspaceId) {
        useWorkspaceStore.setState({ switchingWorkspaceId: null, loading: false });
      }
    }
  })().finally(() => {
    if (workspaceSwitchInFlight === switching) workspaceSwitchInFlight = null;
  });
  workspaceSwitchInFlight = switching;
  return switching;
}
