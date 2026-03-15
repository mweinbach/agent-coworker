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
      const state = get();
      const candidate = state.workspaces.find((workspace) => {
        if (!workspace.iosRelayEnabled) {
          return false;
        }
        return Boolean(state.workspaceRuntimeById[workspace.id]?.serverUrl);
      });

      if (!candidate) {
        if (state.iosRelayState.publishedWorkspaceId) {
          await unpublishWorkspaceRelay({ workspaceId: state.iosRelayState.publishedWorkspaceId });
          await get().requestIosRelayState();
        }
        return;
      }

      const serverUrl = state.workspaceRuntimeById[candidate.id]?.serverUrl;
      if (!serverUrl) {
        return;
      }

      await publishWorkspaceRelay({
        workspaceId: candidate.id,
        workspaceName: candidate.name,
        serverUrl,
      });
      await get().requestIosRelayState();
    },
  };
}
