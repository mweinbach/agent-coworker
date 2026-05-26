import {
  resolvePluginCatalogWorkspaceSelection,
  resolvePluginManagementWorkspaceId,
} from "../pluginManagement";
import {
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
import type { WorkspaceRuntime } from "../types";

export const workspacePathFor = (get: StoreGet, workspaceId: string): string | undefined =>
  ((get() as { workspaces?: Array<{ id: string; path: string }> }).workspaces ?? []).find(
    (workspace) => workspace.id === workspaceId,
  )?.path;

export const managementWorkspaceIdFor = (get: StoreGet): string | null => {
  const state = get();
  return resolvePluginCatalogWorkspaceSelection({
    workspaces: state.workspaces ?? [],
    selectedWorkspaceId: state.selectedWorkspaceId,
    pluginManagementWorkspaceId: state.pluginManagementWorkspaceId,
    pluginManagementMode: state.pluginManagementMode,
  }).catalogWorkspaceId;
};

export function clearFailedMutationSend(
  set: StoreSet,
  workspaceId: string,
  key: string,
  detail: string,
  overrides?: Partial<WorkspaceRuntime>,
): void {
  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: {
        ...s.workspaceRuntimeById[workspaceId],
        skillMutationPendingKeys: (() => {
          const pendingKeys = { ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys };
          delete pendingKeys[key];
          return pendingKeys;
        })(),
        ...(overrides ?? {}),
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

export async function refreshSharedWorkspaceState(
  get: StoreGet,
  set: StoreSet,
  sourceWorkspaceId: string,
): Promise<void> {
  const targetWorkspaceIds = (get().workspaces ?? [])
    .map((workspace) => workspace.id)
    .filter((workspaceId) => {
      if (workspaceId === sourceWorkspaceId) {
        return false;
      }
      const runtime = get().workspaceRuntimeById[workspaceId];
      return !!runtime?.serverUrl && !runtime.error;
    });

  await Promise.allSettled(
    targetWorkspaceIds.map(async (workspaceId) => {
      const cwd = workspacePathFor(get, workspaceId);
      if (!cwd) {
        return;
      }
      ensureWorkspaceRuntime(get, set, workspaceId);
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      await Promise.allSettled([
        requestJsonRpcControlEvent(get, set, workspaceId, "cowork/plugins/catalog/read", { cwd }),
        requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/catalog/read", { cwd }),
        requestJsonRpcControlEvent(get, set, workspaceId, "cowork/skills/list", { cwd }),
        requestJsonRpcControlEvent(get, set, workspaceId, "cowork/mcp/servers/read", { cwd }),
      ]);
    }),
  );
}

export function resolvePluginManagementWorkspace(
  get: StoreGet,
  workspaceId: string | null,
): string | null {
  return resolvePluginManagementWorkspaceId(get().workspaces ?? [], workspaceId);
}
