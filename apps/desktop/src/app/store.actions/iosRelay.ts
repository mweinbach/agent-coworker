import {
  connectIosRelayPeer as runConnectIosRelayPeer,
  disconnectIosRelayPeer as runDisconnectIosRelayPeer,
  getIosRelayState,
  publishWorkspaceRelay,
  startIosRelayAdvertising as runStartIosRelayAdvertising,
  stopIosRelayAdvertising as runStopIosRelayAdvertising,
  unpublishWorkspaceRelay,
} from "../../lib/desktopCommands";
import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  ensureServerRunning,
  persistNow,
} from "../store.helpers";

export function createIosRelayActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "setIosRelayState"
  | "updateIosRelayConfig"
  | "requestIosRelayState"
  | "startIosRelayAdvertising"
  | "stopIosRelayAdvertising"
  | "connectIosRelayPeer"
  | "disconnectIosRelayPeer"
  | "syncIosRelayPublication"
> {
  return {
    setIosRelayState: (iosRelayState) => set({ iosRelayState }),

    updateIosRelayConfig: async (patch) => {
      set((state) => ({
        iosRelayConfig: {
          ...state.iosRelayConfig,
          ...patch,
        },
      }));
      await persistNow(get);
      if (patch.deviceName !== undefined && get().iosRelayState.advertising) {
        await runStartIosRelayAdvertising(get().iosRelayConfig.deviceName ?? undefined);
        await get().requestIosRelayState();
      }
    },

    requestIosRelayState: async () => {
      const iosRelayState = await getIosRelayState();
      set({ iosRelayState });
    },

    startIosRelayAdvertising: async () => {
      await runStartIosRelayAdvertising(get().iosRelayConfig.deviceName ?? undefined);
      await get().requestIosRelayState();
    },

    stopIosRelayAdvertising: async () => {
      await runStopIosRelayAdvertising();
      await get().requestIosRelayState();
    },

    connectIosRelayPeer: async (peerId: string) => {
      await runConnectIosRelayPeer({ peerId });
      await get().requestIosRelayState();
    },

    disconnectIosRelayPeer: async () => {
      await runDisconnectIosRelayPeer();
      await get().requestIosRelayState();
    },

    syncIosRelayPublication: async () => {
      const initialState = get();
      if (!initialState.iosRelayState.supported) {
        return;
      }

      const candidate = initialState.workspaces.find((workspace) => {
        if (!workspace.iosRelayEnabled) {
          return false;
        }
        return true;
      });

      if (!candidate) {
        if (initialState.iosRelayState.publishedWorkspaceId) {
          await unpublishWorkspaceRelay({ workspaceId: initialState.iosRelayState.publishedWorkspaceId });
        }
        if (initialState.iosRelayState.advertising) {
          await runStopIosRelayAdvertising();
        }
        await get().requestIosRelayState();
        return;
      }

      if (!initialState.workspaceRuntimeById[candidate.id]?.serverUrl) {
        await ensureServerRunning(get, set, candidate.id);
        return;
      }

      const state = get();
      const serverUrl = state.workspaceRuntimeById[candidate.id]?.serverUrl;
      if (!serverUrl) {
        return;
      }

      await runStartIosRelayAdvertising(state.iosRelayConfig.deviceName ?? undefined);
      await publishWorkspaceRelay({
        workspaceId: candidate.id,
        workspaceName: candidate.name,
        serverUrl,
      });
      await get().requestIosRelayState();
    },
  };
}
