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
import { workspacePathFor } from "./skillPluginHelpers";

export function createAgentProfileActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  "refreshAgentProfilesCatalog" | "upsertAgentProfile" | "deleteAgentProfile" | "copyAgentProfile"
> {
  const resolveWorkspaceId = (workspaceId?: string): string | null =>
    workspaceId ?? get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;

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

  return {
    refreshAgentProfilesCatalog: async (workspaceIdArg) => {
      const workspaceId = resolveWorkspaceId(workspaceIdArg);
      if (!workspaceId) return;
      const cwd = workspacePathFor(get, workspaceId);
      await prepareWorkspace(workspaceId);
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
      );
      if (!ok) {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              agentProfilesLoading: false,
              agentProfilesError: "Unable to refresh subagent profiles.",
            },
          },
        }));
        notifyFailure("Subagent profiles unavailable", "Unable to refresh subagent profiles.");
      }
    },

    upsertAgentProfile: async (profile) => {
      const workspaceId = resolveWorkspaceId();
      if (!workspaceId) return;
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
      );
      if (!ok) {
        notifyFailure(
          "Unable to save subagent profile",
          rpcError.message?.trim() || "The profile could not be saved.",
        );
      }
    },

    deleteAgentProfile: async (scope, id) => {
      const workspaceId = resolveWorkspaceId();
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
      );
      if (!ok) {
        notifyFailure(
          "Unable to delete subagent profile",
          rpcError.message?.trim() || "The profile could not be deleted.",
        );
      }
    },

    copyAgentProfile: async (copy: AgentProfileCopyInput) => {
      const workspaceId = resolveWorkspaceId();
      if (!workspaceId) return;
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
      );
      if (!ok) {
        notifyFailure(
          "Unable to copy subagent profile",
          rpcError.message?.trim() || "The profile could not be copied.",
        );
      }
    },
  };
}
