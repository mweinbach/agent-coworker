import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  makeId,
  nowIso,
  pushNotification,
  requestJsonRpcControlEvent,
  type StoreGet,
  type StoreSet,
} from "../store.helpers";
import {
  clearFailedMutationSend,
  clearMutationPending,
  dismissMutationError,
  managementWorkspaceIdFor,
  mutationPendingKey,
  setMutationPending,
  workspacePathFor,
} from "./skillPluginHelpers";

/** Matches the server's `clearedMutationPendingKeys` on catalog refresh events. */
export const MARKETPLACE_ADD_PENDING_KEY = "marketplace:add";

export function marketplaceRemovePendingKey(id: string): string {
  return mutationPendingKey("marketplace:remove", id);
}

export function createMarketplaceActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "refreshMarketplaces"
  | "selectMarketplace"
  | "readMarketplaceDetail"
  | "addMarketplace"
  | "removeMarketplace"
  | "dismissMarketplaceMutationError"
> {
  const readMarketplaceDetail = async (id: string, targetWorkspaceId?: string) => {
    const workspaceId = targetWorkspaceId ?? managementWorkspaceIdFor(get);
    if (!workspaceId) return;
    ensureWorkspaceRuntime(get, set, workspaceId);
    set((s) => ({
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...s.workspaceRuntimeById[workspaceId],
          marketplaceDetailLoading: true,
          marketplaceDetailError: null,
        },
      },
    }));
    await ensureServerRunning(get, set, workspaceId);
    const readyRuntime = get().workspaceRuntimeById[workspaceId];
    if (!readyRuntime?.serverUrl || readyRuntime.error) {
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            marketplaceDetailLoading: false,
            marketplaceDetailError: "Unable to load marketplace details.",
          },
        },
      }));
      return;
    }
    ensureControlSocket(get, set, workspaceId);
    const cwd = workspacePathFor(get, workspaceId);
    // Assembling the detail re-fetches the marketplace manifest over the
    // network, so the loading flag stays set until the `marketplace_detail`
    // event lands.
    const rpcError: { message?: string } = {};
    const ok = await requestJsonRpcControlEvent(
      get,
      set,
      workspaceId,
      "cowork/marketplaces/detail",
      { cwd, id },
      rpcError,
    );
    if (!ok) {
      const detail = rpcError.message?.trim() || "Unable to load marketplace details.";
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            marketplaceDetailLoading: false,
            marketplaceDetailError: detail,
          },
        },
      }));
    }
  };

  return {
    refreshMarketplaces: async (targetWorkspaceId?: string) => {
      const workspaceId = targetWorkspaceId ?? managementWorkspaceIdFor(get);
      if (!workspaceId) return;
      ensureWorkspaceRuntime(get, set, workspaceId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            marketplacesLoading: true,
            marketplacesError: null,
          },
        },
      }));
      await ensureServerRunning(get, set, workspaceId);
      const readyRuntime = get().workspaceRuntimeById[workspaceId];
      if (!readyRuntime?.serverUrl || readyRuntime.error) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              marketplacesLoading: false,
              marketplacesError: "Unable to load marketplaces.",
            },
          },
        }));
        return;
      }
      ensureControlSocket(get, set, workspaceId);
      const cwd = workspacePathFor(get, workspaceId);
      // The read fetches every configured manifest over the network, so it can
      // take several seconds; the loading flag stays set until the
      // `marketplaces_list` event lands.
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/marketplaces/read",
        { cwd },
        rpcError,
      );
      if (!ok) {
        const detail = rpcError.message?.trim() || "Unable to load marketplaces.";
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              marketplacesLoading: false,
              marketplacesError: detail,
            },
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail,
          }),
        }));
      }
    },

    selectMarketplace: async (id: string | null) => {
      const workspaceId = managementWorkspaceIdFor(get);
      if (!workspaceId) return;
      ensureWorkspaceRuntime(get, set, workspaceId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            selectedMarketplaceId: id,
            selectedMarketplaceDetail: null,
            marketplaceDetailLoading: false,
            marketplaceDetailError: null,
          },
        },
      }));
      if (id === null) return;
      await readMarketplaceDetail(id, workspaceId);
    },

    readMarketplaceDetail,

    addMarketplace: async (sourceInput: string) => {
      const workspaceId = managementWorkspaceIdFor(get);
      if (!workspaceId) {
        throw new Error("No workspace selected");
      }
      const cwd = workspacePathFor(get, workspaceId);
      const key = MARKETPLACE_ADD_PENDING_KEY;
      setMutationPending(set, workspaceId, "marketplace", key);
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/marketplaces/add",
        { cwd, sourceInput },
        rpcError,
      );
      if (!ok) {
        const detail = rpcError.message?.trim() || "Unable to add marketplace.";
        clearFailedMutationSend(
          set,
          workspaceId,
          key,
          detail,
          { marketplaceMutationError: detail },
          "marketplace",
        );
        throw new Error(detail);
      }
      // The result already carried the fresh `marketplaces_list`; the server's
      // follow-up catalog events also clear this key via clearedMutationPendingKeys.
      clearMutationPending(set, workspaceId, "marketplace", key);
    },

    removeMarketplace: async (id: string) => {
      const workspaceId = managementWorkspaceIdFor(get);
      if (!workspaceId) return;
      const cwd = workspacePathFor(get, workspaceId);
      const key = marketplaceRemovePendingKey(id);
      setMutationPending(set, workspaceId, "marketplace", key);
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/marketplaces/remove",
        { cwd, id },
        rpcError,
      );
      if (!ok) {
        const detail = rpcError.message?.trim() || "Unable to remove marketplace.";
        clearFailedMutationSend(
          set,
          workspaceId,
          key,
          detail,
          { marketplaceMutationError: detail },
          "marketplace",
        );
        return;
      }
      clearMutationPending(set, workspaceId, "marketplace", key);
    },

    dismissMarketplaceMutationError: (targetWorkspaceId?: string) => {
      dismissMutationError(get, set, "marketplace", targetWorkspaceId);
    },
  };
}
