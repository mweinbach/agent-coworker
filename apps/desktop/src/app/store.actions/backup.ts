import {
  type AppStoreActions,
  appendThreadTranscript,
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  makeId,
  nowIso,
  pushNotification,
  requestJsonRpcControlEvent,
  type StoreGet,
  type StoreSet,
  sendThread,
} from "../store.helpers";
import { workspaceBackupActionKey } from "../store.helpers/backupActionKey";
import { operationKey, runAcknowledgedOperation } from "../store.helpers/operations";

function setWorkspaceBackupsLoading(
  set: StoreSet,
  workspaceId: string,
  loading: boolean,
  error: string | null = null,
) {
  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: {
        ...s.workspaceRuntimeById[workspaceId],
        workspaceBackupsLoading: loading,
        workspaceBackupsError: error,
      },
    },
  }));
}

function addWorkspaceBackupPendingAction(set: StoreSet, workspaceId: string, actionKey: string) {
  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: {
        ...s.workspaceRuntimeById[workspaceId],
        workspaceBackupPendingActionKeys: {
          ...s.workspaceRuntimeById[workspaceId].workspaceBackupPendingActionKeys,
          [actionKey]: true,
        },
      },
    },
  }));
}

function clearWorkspaceBackupPendingAction(set: StoreSet, workspaceId: string, actionKey: string) {
  set((s) => {
    const current = { ...s.workspaceRuntimeById[workspaceId].workspaceBackupPendingActionKeys };
    delete current[actionKey];
    return {
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...s.workspaceRuntimeById[workspaceId],
          workspaceBackupPendingActionKeys: current,
        },
      },
    };
  });
}

export function createWorkspaceBackupActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "requestWorkspaceBackupDelta"
  | "requestWorkspaceBackups"
  | "createWorkspaceBackupCheckpoint"
  | "restoreWorkspaceBackupOriginal"
  | "restoreWorkspaceBackupCheckpoint"
  | "deleteWorkspaceBackupCheckpoint"
  | "deleteWorkspaceBackupEntry"
  | "setWorkspaceBackupSessionEnabled"
> {
  async function ensureWorkspaceControl(workspaceId: string): Promise<boolean> {
    ensureWorkspaceRuntime(get, set, workspaceId);
    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);
    return true;
  }

  async function requestBackupMutation(options: {
    workspaceId: string;
    targetSessionId: string;
    checkpointId?: string;
    action: string;
    label: string;
    errorTitle: string;
    errorMessage: string;
    method:
      | "cowork/backups/workspace/checkpoint"
      | "cowork/backups/workspace/restore"
      | "cowork/backups/workspace/deleteCheckpoint"
      | "cowork/backups/workspace/deleteEntry";
  }) {
    const {
      workspaceId,
      targetSessionId,
      checkpointId,
      action,
      label,
      errorTitle,
      errorMessage,
      method,
    } = options;
    ensureWorkspaceRuntime(get, set, workspaceId);
    const pendingActionKey = workspaceBackupActionKey(action, targetSessionId, checkpointId);

    return await runAcknowledgedOperation(get, set, {
      key: operationKey("backup", action, workspaceId, targetSessionId, checkpointId),
      label,
      errorTitle,
      errorMessage,
      repairAction: "Confirm the workspace session is connected and retry.",
      optimistic: () => {
        addWorkspaceBackupPendingAction(set, workspaceId, pendingActionKey);
        return () => clearWorkspaceBackupPendingAction(set, workspaceId, pendingActionKey);
      },
      execute: async () => {
        await ensureWorkspaceControl(workspaceId);
        const ok = await requestJsonRpcControlEvent(get, set, workspaceId, method, {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
          targetSessionId,
          ...(checkpointId ? { checkpointId } : {}),
        });
        if (!ok) {
          throw new Error(errorMessage);
        }
      },
    });
  }

  function notifyNotConnected(detail: string) {
    set((state) => ({
      notifications: pushNotification(state.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: "error",
        title: "Not connected",
        detail,
        audience: "foreground",
      }),
    }));
  }

  return {
    requestWorkspaceBackups: async (workspaceId: string) => {
      await ensureWorkspaceControl(workspaceId);
      setWorkspaceBackupsLoading(set, workspaceId, true, null);

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/backups/workspace/read",
        {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
        },
      );
      if (ok) return;

      setWorkspaceBackupsLoading(set, workspaceId, false, "Unable to request workspace backups.");
      notifyNotConnected("Unable to request workspace backups.");
    },

    requestWorkspaceBackupDelta: async (
      workspaceId: string,
      targetSessionId: string,
      checkpointId: string,
    ) => {
      await ensureWorkspaceControl(workspaceId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            workspaceBackupDeltaLoading: true,
            workspaceBackupDeltaError: null,
          },
        },
      }));

      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/backups/workspace/delta/read",
        {
          cwd: get().workspaces.find((workspace) => workspace.id === workspaceId)?.path,
          targetSessionId,
          checkpointId,
        },
      );
      if (ok) return;

      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            workspaceBackupDeltaLoading: false,
            workspaceBackupDeltaError: "Unable to inspect workspace backup delta.",
          },
        },
      }));
      notifyNotConnected("Unable to inspect the selected workspace checkpoint.");
    },

    createWorkspaceBackupCheckpoint: async (workspaceId: string, targetSessionId: string) => {
      return await requestBackupMutation({
        workspaceId,
        targetSessionId,
        action: "checkpoint",
        label: "Create workspace checkpoint",
        errorTitle: "Checkpoint not created",
        errorMessage: "Unable to create a workspace checkpoint.",
        method: "cowork/backups/workspace/checkpoint",
      });
    },

    restoreWorkspaceBackupOriginal: async (workspaceId: string, targetSessionId: string) => {
      return await requestBackupMutation({
        workspaceId,
        targetSessionId,
        action: "restore-original",
        label: "Restore original workspace snapshot",
        errorTitle: "Workspace not restored",
        errorMessage: "Unable to restore the original workspace snapshot.",
        method: "cowork/backups/workspace/restore",
      });
    },

    restoreWorkspaceBackupCheckpoint: async (
      workspaceId: string,
      targetSessionId: string,
      checkpointId: string,
    ) => {
      return await requestBackupMutation({
        workspaceId,
        targetSessionId,
        checkpointId,
        action: "restore-checkpoint",
        label: "Restore workspace checkpoint",
        errorTitle: "Checkpoint not restored",
        errorMessage: "Unable to restore the selected checkpoint.",
        method: "cowork/backups/workspace/restore",
      });
    },

    deleteWorkspaceBackupCheckpoint: async (
      workspaceId: string,
      targetSessionId: string,
      checkpointId: string,
    ) => {
      return await requestBackupMutation({
        workspaceId,
        targetSessionId,
        checkpointId,
        action: "delete-checkpoint",
        label: "Delete workspace checkpoint",
        errorTitle: "Checkpoint not deleted",
        errorMessage: "Unable to delete the selected checkpoint.",
        method: "cowork/backups/workspace/deleteCheckpoint",
      });
    },

    deleteWorkspaceBackupEntry: async (workspaceId: string, targetSessionId: string) => {
      return await requestBackupMutation({
        workspaceId,
        targetSessionId,
        action: "delete-entry",
        label: "Delete workspace backup",
        errorTitle: "Backup not deleted",
        errorMessage: "Unable to delete the selected backup entry.",
        method: "cowork/backups/workspace/deleteEntry",
      });
    },

    setWorkspaceBackupSessionEnabled: async (
      workspaceId: string,
      targetSessionId: string,
      enabled: boolean,
    ) => {
      const thread = get().threads.find(
        (entry) =>
          entry.workspaceId === workspaceId &&
          get().threadRuntimeById[entry.id]?.sessionId === targetSessionId,
      );
      const previousSessionConfig = thread
        ? (get().threadRuntimeById[thread.id]?.sessionConfig ?? null)
        : null;

      return await runAcknowledgedOperation(get, set, {
        key: operationKey("backup", "session-enabled", workspaceId, targetSessionId),
        label: enabled ? "Enable session backups" : "Disable session backups",
        errorTitle: "Session backup setting not updated",
        errorMessage: "Unable to update the selected session backup setting.",
        repairAction: "Confirm the selected session is connected and retry.",
        optimistic: () => {
          if (!thread) return undefined;
          set((state) => {
            const runtime = state.threadRuntimeById[thread.id];
            if (!runtime?.sessionConfig) return {};
            return {
              threadRuntimeById: {
                ...state.threadRuntimeById,
                [thread.id]: {
                  ...runtime,
                  sessionConfig: {
                    ...runtime.sessionConfig,
                    backupsEnabled: enabled,
                  },
                },
              },
            };
          });
          return () => {
            set((state) => {
              const runtime = state.threadRuntimeById[thread.id];
              if (!runtime) return {};
              return {
                threadRuntimeById: {
                  ...state.threadRuntimeById,
                  [thread.id]: {
                    ...runtime,
                    sessionConfig: previousSessionConfig,
                  },
                },
              };
            });
          };
        },
        execute: async () => {
          if (!thread) {
            throw new Error("Connect the selected session to change its backup setting.");
          }
          const ok = sendThread(get, thread.id, (sessionId) => ({
            type: "set_config",
            sessionId,
            config: {
              backupsEnabled: enabled,
            },
          }));
          if (!ok) {
            throw new Error("Unable to update the selected session backup setting.");
          }
          appendThreadTranscript(thread.id, "client", {
            type: "set_config",
            sessionId: targetSessionId,
            config: {
              backupsEnabled: enabled,
            },
          });
        },
      });
    },
  };
}
