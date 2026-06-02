import type { AgentProfileCopyInput } from "../../../../../src/shared/agentProfiles";
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
  bumpAgentProfilesCatalogGeneration,
  getAgentProfilesCatalogGeneration,
} from "../store.helpers/runtimeState";
import { workspacePathFor } from "./skillPluginHelpers";

export function createAgentProfileActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  "refreshAgentProfilesCatalog" | "upsertAgentProfile" | "deleteAgentProfile" | "copyAgentProfile"
> {
  const resolveWorkspaceId = (workspaceId?: string): string | null => {
    const workspaces = get().workspaces ?? [];
    const isKnownWorkspace = (id: string | null | undefined): id is string =>
      Boolean(id && workspaces.some((workspace) => workspace.id === id));
    if (workspaceId) return isKnownWorkspace(workspaceId) ? workspaceId : null;
    const selectedWorkspaceId = get().selectedWorkspaceId;
    return isKnownWorkspace(selectedWorkspaceId)
      ? selectedWorkspaceId
      : (workspaces[0]?.id ?? null);
  };

  const prepareWorkspace = async (workspaceId: string) => {
    ensureWorkspaceRuntime(get, set, workspaceId);
    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);
  };

  const notifyFailure = (title: string, detail: string) => {
    set((s) => ({
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: "error",
        title,
        detail,
      }),
    }));
  };

  const shouldApplyCatalogRead = (workspaceId: string, generation: number) => (event: unknown) =>
    event === null ||
    typeof event !== "object" ||
    !("type" in event) ||
    event.type !== "agent_profiles_catalog" ||
    getAgentProfilesCatalogGeneration(workspaceId) === generation;

  const bumpBeforeCatalogMutationEvent = (workspaceId: string) => (event: unknown) => {
    if (
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      event.type === "agent_profiles_catalog"
    ) {
      bumpAgentProfilesCatalogGeneration(workspaceId);
    }
  };

  return {
    refreshAgentProfilesCatalog: async (workspaceIdArg) => {
      const workspaceId = resolveWorkspaceId(workspaceIdArg);
      if (!workspaceId) return;
      const cwd = workspacePathFor(get, workspaceId);
      await prepareWorkspace(workspaceId);
      const generation = getAgentProfilesCatalogGeneration(workspaceId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            agentProfilesLoading: true,
            agentProfilesError: null,
          },
        },
      }));
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/agentProfiles/catalog/read",
        { cwd },
        undefined,
        { shouldApplyEvent: shouldApplyCatalogRead(workspaceId, generation) },
      );
      const generationChanged = getAgentProfilesCatalogGeneration(workspaceId) !== generation;
      const stillLoading = get().workspaceRuntimeById[workspaceId]?.agentProfilesLoading;
      if (!ok || stillLoading) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              agentProfilesLoading: false,
              agentProfilesError: generationChanged
                ? (s.workspaceRuntimeById[workspaceId]?.agentProfilesError ?? null)
                : "Unable to refresh subagent profiles.",
            },
          },
        }));
        if (!generationChanged) {
          notifyFailure("Subagent profiles unavailable", "Unable to refresh subagent profiles.");
        }
      }
    },

    upsertAgentProfile: async (profile, workspaceIdArg) => {
      const workspaceId = resolveWorkspaceId(workspaceIdArg);
      if (!workspaceId) return false;
      const cwd = workspacePathFor(get, workspaceId);
      await prepareWorkspace(workspaceId);
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/agentProfiles/upsert",
        { cwd, profile },
        rpcError,
        { beforeApplyEvent: bumpBeforeCatalogMutationEvent(workspaceId) },
      );
      if (!ok) {
        notifyFailure(
          "Unable to save subagent profile",
          rpcError.message?.trim() || "The profile could not be saved.",
        );
        return false;
      }
      return true;
    },

    deleteAgentProfile: async (scope, id, workspaceIdArg) => {
      const workspaceId = resolveWorkspaceId(workspaceIdArg);
      if (!workspaceId) return;
      const cwd = workspacePathFor(get, workspaceId);
      await prepareWorkspace(workspaceId);
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/agentProfiles/delete",
        { cwd, scope, id },
        rpcError,
        { beforeApplyEvent: bumpBeforeCatalogMutationEvent(workspaceId) },
      );
      if (!ok) {
        notifyFailure(
          "Unable to delete subagent profile",
          rpcError.message?.trim() || "The profile could not be deleted.",
        );
      }
    },

    copyAgentProfile: async (copy: AgentProfileCopyInput, workspaceIdArg) => {
      const workspaceId = resolveWorkspaceId(workspaceIdArg);
      if (!workspaceId) return false;
      const cwd = workspacePathFor(get, workspaceId);
      await prepareWorkspace(workspaceId);
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/agentProfiles/copy",
        { cwd, copy },
        rpcError,
        { beforeApplyEvent: bumpBeforeCatalogMutationEvent(workspaceId) },
      );
      if (!ok) {
        notifyFailure(
          "Unable to copy subagent profile",
          rpcError.message?.trim() || "The profile could not be copied.",
        );
        return false;
      }
      return true;
    },
  };
}
