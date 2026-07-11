import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  makeId,
  nowIso,
  operationKey,
  pushNotification,
  requestJsonRpcControlEvent,
  runAcknowledgedOperation,
  type StoreGet,
  type StoreSet,
} from "../store.helpers";

export function createOpenAiNativeConnectorActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "requestOpenAiNativeConnectors"
  | "refreshOpenAiNativeConnectors"
  | "setOpenAiNativeConnectorEnabled"
> {
  async function requestConnectors(
    workspaceId: string,
    method: "cowork/connectors/openai-native/list" | "cowork/connectors/openai-native/refresh",
  ) {
    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);
    const cwd = get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
    set((s) => ({
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...s.workspaceRuntimeById[workspaceId],
          openAiNativeConnectorsLoading: true,
          openAiNativeConnectorsError: null,
        },
      },
    }));
    const errorDetail: { message?: string } = {};
    const ok = await requestJsonRpcControlEvent(
      get,
      set,
      workspaceId,
      method,
      { cwd },
      errorDetail,
    );
    if (ok) return;
    set((s) => ({
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...s.workspaceRuntimeById[workspaceId],
          openAiNativeConnectorsLoading: false,
          openAiNativeConnectorsError: errorDetail.message ?? "Unable to load OpenAI connectors.",
        },
      },
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: "error",
        title: "OpenAI connectors unavailable",
        detail: errorDetail.message ?? "Unable to load OpenAI native connectors.",
      }),
    }));
  }

  return {
    requestOpenAiNativeConnectors: async (workspaceId) => {
      await requestConnectors(workspaceId, "cowork/connectors/openai-native/list");
    },

    refreshOpenAiNativeConnectors: async (workspaceId) => {
      await requestConnectors(workspaceId, "cowork/connectors/openai-native/refresh");
    },

    setOpenAiNativeConnectorEnabled: async (workspaceId, connectorId, enabled) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("connector", "enabled", workspaceId, connectorId),
        label: "Update OpenAI connector",
        errorTitle: "Connector setting not saved",
        errorMessage: `Unable to update ${connectorId}.`,
        repairAction: "Verify the connector is accessible in ChatGPT, then retry.",
        execute: async () => {
          await ensureServerRunning(get, set, workspaceId);
          ensureControlSocket(get, set, workspaceId);
          const cwd = get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
          const errorDetail: { message?: string } = {};
          const ok = await requestJsonRpcControlEvent(
            get,
            set,
            workspaceId,
            "cowork/connectors/openai-native/setEnabled",
            { cwd, connectorId, enabled },
            errorDetail,
          );
          if (!ok) {
            throw new Error(errorDetail.message?.trim() || `Unable to update ${connectorId}.`);
          }
        },
      });
    },
  };
}
