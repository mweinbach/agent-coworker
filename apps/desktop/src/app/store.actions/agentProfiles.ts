import type { AgentProfileCopyInput } from "../../../../../src/shared/agentProfiles";
import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  makeId,
  nowIso,
  operationKey,
  pushNotification,
  requestJsonRpcControlEvent,
  runAcknowledgedOperation,
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
  | "refreshAgentProfilesCatalog"
  | "upsertAgentProfile"
  | "deleteAgentProfile"
  | "copyAgentProfile"
  | "setAgentProfileWorkspaceAvailability"
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
    set((state) => ({
      notifications: pushNotification(state.notifications, {
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

  const requestAgentProfileMutation = async (options: {
    workspaceId: string;
    action: string;
    subjectId: string;
    label: string;
    errorTitle: string;
    errorMessage: string;
    method: string;
    params: Record<string, unknown>;
  }) =>
    await runAcknowledgedOperation(get, set, {
      key: operationKey("agent-profile", options.action, options.workspaceId, options.subjectId),
      label: options.label,
      errorTitle: options.errorTitle,
      errorMessage: options.errorMessage,
      repairAction: "Review the profile settings and retry.",
      execute: async () => {
        await prepareWorkspace(options.workspaceId);
        const rpcError: { message?: string } = {};
        const ok = await requestJsonRpcControlEvent(
          get,
          set,
          options.workspaceId,
          options.method,
          options.params,
          rpcError,
          { beforeApplyEvent: bumpBeforeCatalogMutationEvent(options.workspaceId) },
        );
        if (!ok) {
          throw new Error(rpcError.message?.trim() || options.errorMessage);
        }
      },
    });

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
      const subjectId = `${profile.scope}:${profile.id}`;
      if (!workspaceId) {
        return await runAcknowledgedOperation(get, set, {
          key: operationKey("agent-profile", "save", "missing-workspace", subjectId),
          label: "Save subagent profile",
          errorTitle: "Subagent profile not saved",
          errorMessage: "Add or select a workspace before saving a subagent profile.",
          repairAction: "Add or select a workspace, then retry.",
          execute: async () => {
            throw new Error("Add or select a workspace before saving a subagent profile.");
          },
        });
      }
      const cwd = workspacePathFor(get, workspaceId);
      return await requestAgentProfileMutation({
        workspaceId,
        action: "save",
        subjectId,
        label: "Save subagent profile",
        errorTitle: "Subagent profile not saved",
        errorMessage: "The profile could not be saved.",
        method: "cowork/agentProfiles/upsert",
        params: { cwd, profile },
      });
    },

    deleteAgentProfile: async (scope, id, workspaceIdArg) => {
      const workspaceId = resolveWorkspaceId(workspaceIdArg);
      const subjectId = `${scope}:${id}`;
      if (!workspaceId) {
        return await runAcknowledgedOperation(get, set, {
          key: operationKey("agent-profile", "delete", "missing-workspace", subjectId),
          label: "Delete subagent profile",
          errorTitle: "Subagent profile not deleted",
          errorMessage: "Add or select a workspace before deleting a subagent profile.",
          repairAction: "Add or select a workspace, then retry.",
          execute: async () => {
            throw new Error("Add or select a workspace before deleting a subagent profile.");
          },
        });
      }
      const cwd = workspacePathFor(get, workspaceId);
      return await requestAgentProfileMutation({
        workspaceId,
        action: "delete",
        subjectId,
        label: "Delete subagent profile",
        errorTitle: "Subagent profile not deleted",
        errorMessage: "The profile could not be deleted.",
        method: "cowork/agentProfiles/delete",
        params: { cwd, scope, id },
      });
    },

    setAgentProfileWorkspaceAvailability: async (id, disabled, workspaceIdArg) => {
      const workspaceId = resolveWorkspaceId(workspaceIdArg);
      if (!workspaceId) {
        return await runAcknowledgedOperation(get, set, {
          key: operationKey("agent-profile", "availability", "missing-workspace", id),
          label: "Update subagent availability",
          errorTitle: "Subagent availability not updated",
          errorMessage: "Add or select a workspace before changing subagent availability.",
          repairAction: "Add or select a workspace, then retry.",
          execute: async () => {
            throw new Error("Add or select a workspace before changing subagent availability.");
          },
        });
      }
      const cwd = workspacePathFor(get, workspaceId);
      return await requestAgentProfileMutation({
        workspaceId,
        action: "availability",
        subjectId: id,
        label: "Update subagent availability",
        errorTitle: "Subagent availability not updated",
        errorMessage: "The subagent availability could not be updated.",
        method: "cowork/agentProfiles/workspaceAvailability/set",
        params: { cwd, id, disabled },
      });
    },

    copyAgentProfile: async (copy: AgentProfileCopyInput, workspaceIdArg) => {
      const workspaceId = resolveWorkspaceId(workspaceIdArg);
      const subjectId = `${copy.sourceRef}:${copy.targetScope}`;
      if (!workspaceId) {
        return await runAcknowledgedOperation(get, set, {
          key: operationKey("agent-profile", "copy", "missing-workspace", subjectId),
          label: "Copy subagent profile",
          errorTitle: "Subagent profile not copied",
          errorMessage: "Add or select a workspace before copying a subagent profile.",
          repairAction: "Add or select a workspace, then retry.",
          execute: async () => {
            throw new Error("Add or select a workspace before copying a subagent profile.");
          },
        });
      }
      const cwd = workspacePathFor(get, workspaceId);
      return await requestAgentProfileMutation({
        workspaceId,
        action: "copy",
        subjectId,
        label: "Copy subagent profile",
        errorTitle: "Subagent profile not copied",
        errorMessage: "The profile could not be copied.",
        method: "cowork/agentProfiles/copy",
        params: { cwd, copy },
      });
    },
  };
}
