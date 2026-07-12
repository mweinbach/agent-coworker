import { jsonRpcCreationResultSchemas } from "../../../../../src/server/jsonrpc/schema.creation";
import type {
  CreationPreflightParams,
  CreationPreflightResult,
  CreationRepairAction,
} from "../../../../../src/shared/creationReadiness";
import * as desktopCommands from "../../lib/desktopCommands";
import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import {
  bumpWorkspaceJsonRpcSocketGeneration,
  bumpWorkspaceStartGeneration,
  clearWorkspaceJsonRpcSocketGeneration,
  clearWorkspaceStartState,
  disposeWorkspaceJsonRpcState,
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  persistNow,
  RUNTIME,
} from "../store.helpers";
import { parseJsonRpcResult, requestJsonRpc } from "../store.helpers/jsonRpcSocket";
import { createOneOffWorkspaceRecord } from "../store.helpers/oneOffWorkspaceRecord";

type CreationPreflightRequest = CreationPreflightParams & {
  workspaceId?: string;
};

function resolveTransportWorkspaceId(get: StoreGet, requested?: string): string | null {
  if (requested && get().workspaces.some((workspace) => workspace.id === requested)) {
    return requested;
  }
  const selected = get().selectedWorkspaceId;
  if (selected && get().workspaces.some((workspace) => workspace.id === selected)) {
    return selected;
  }
  return get().workspaces[0]?.id ?? null;
}

export function createCreationReadinessActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  "preflightCreation" | "repairCreationReadiness" | "releasePreparedQuickChatWorkspace"
> {
  let quickChatReleaseRequested = false;
  let quickChatPreparationPending = false;
  const releasePreparedQuickChatWorkspace = async (): Promise<void> => {
    const workspaceId = get().quickChatPreparedWorkspaceId;
    if (!workspaceId) {
      quickChatReleaseRequested = quickChatPreparationPending;
      return;
    }
    quickChatReleaseRequested = false;
    const workspace = get().workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      set({ quickChatPreparedWorkspaceId: null });
      return;
    }

    bumpWorkspaceStartGeneration(workspaceId);
    bumpWorkspaceJsonRpcSocketGeneration(workspaceId);
    const socket = RUNTIME.jsonRpcSockets.get(workspaceId);
    try {
      socket?.close();
    } catch {
      // ignore
    }
    RUNTIME.jsonRpcSockets.delete(workspaceId);
    clearWorkspaceJsonRpcSocketGeneration(workspaceId);
    try {
      await desktopCommands.stopWorkspaceServer({ workspaceId });
    } catch {
      // ignore
    } finally {
      disposeWorkspaceJsonRpcState(get, workspaceId);
      clearWorkspaceStartState(workspaceId);
    }

    set((state) => {
      const remainingWorkspaces = state.workspaces.filter((entry) => entry.id !== workspaceId);
      return {
        workspaces: remainingWorkspaces,
        quickChatPreparedWorkspaceId: null,
        selectedWorkspaceId:
          state.selectedWorkspaceId === workspaceId
            ? (remainingWorkspaces[0]?.id ?? null)
            : state.selectedWorkspaceId,
      };
    });
    await persistNow(get);
    try {
      await desktopCommands.trashPath({ path: workspace.path });
    } catch {
      // Best-effort cleanup; the path remains confined to Cowork's one-off chat root.
    }
  };

  return {
    preflightCreation: async (
      request: CreationPreflightRequest,
      options = {},
    ): Promise<CreationPreflightResult> => {
      let workspaceId = resolveTransportWorkspaceId(get, request.workspaceId);
      if (!workspaceId) {
        if (request.kind === "chat" && !request.cwd) {
          const prepared = get().quickChatPreparedWorkspaceId
            ? get().workspaces.find(
                (workspace) => workspace.id === get().quickChatPreparedWorkspaceId,
              )
            : null;
          let workspace = prepared;
          if (!workspace) {
            quickChatPreparationPending = true;
            try {
              workspace = await createOneOffWorkspaceRecord(get, "Quick chat readiness");
            } finally {
              quickChatPreparationPending = false;
            }
          }
          if (!prepared) {
            set((state) => ({
              workspaces: [workspace, ...state.workspaces],
              quickChatPreparedWorkspaceId: workspace.id,
            }));
            ensureWorkspaceRuntime(get, set, workspace.id);
            if (quickChatReleaseRequested) {
              await releasePreparedQuickChatWorkspace();
              const error = new Error("Creation cancelled.");
              error.name = "AbortError";
              throw error;
            }
          }
          workspaceId = workspace.id;
        } else {
          return {
            ready: false,
            checks: [
              {
                id: "project_access",
                status: "blocked",
                message: "Choose or add a workspace before starting.",
              },
            ],
          };
        }
      }

      await ensureServerRunning(get, set, workspaceId, { signal: options.signal });
      ensureControlSocket(get, set, workspaceId);
      const params: CreationPreflightParams = {
        kind: request.kind,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.provider ? { provider: request.provider } : {}),
        ...(request.model ? { model: request.model } : {}),
      };
      const result = await requestJsonRpc(
        get,
        set,
        workspaceId,
        "cowork/creation/preflight",
        params,
        options,
      );
      return parseJsonRpcResult(
        "cowork/creation/preflight",
        jsonRpcCreationResultSchemas["cowork/creation/preflight"],
        result,
      );
    },

    repairCreationReadiness: async (
      action: CreationRepairAction,
      workspaceId?: string,
    ): Promise<void> => {
      switch (action.type) {
        case "connectProvider":
        case "openProviderSettings":
          get().openSettings("providers");
          return;
        case "installCodexRuntime":
          await get().updateCodexAppServer();
          return;
        case "startLmStudio": {
          if (!action.canAutoStart) {
            get().openSettings("providers");
            return;
          }
          const transportWorkspaceId = resolveTransportWorkspaceId(get, workspaceId);
          if (!transportWorkspaceId) {
            throw new Error("Choose or add a workspace before starting LM Studio.");
          }
          await ensureServerRunning(get, set, transportWorkspaceId);
          ensureControlSocket(get, set, transportWorkspaceId);
          await requestJsonRpc(
            get,
            set,
            transportWorkspaceId,
            "cowork/provider/lmstudio/local/start",
            { baseUrl: action.baseUrl },
          );
          await get().refreshProviderStatus({ workspaceId: transportWorkspaceId });
          return;
        }
        default: {
          const exhaustiveAction: never = action;
          throw new Error(`Unsupported creation repair action: ${String(exhaustiveAction)}`);
        }
      }
    },

    releasePreparedQuickChatWorkspace,
  };
}
