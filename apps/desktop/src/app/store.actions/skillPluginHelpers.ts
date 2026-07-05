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
import { resolveManagementWorkspaceId } from "../workspaceDisplayTargets";

export type MutationDomain = "skill" | "plugin";

function mutationPendingField(
  domain: MutationDomain,
): keyof Pick<WorkspaceRuntime, "skillMutationPendingKeys" | "pluginMutationPendingKeys"> {
  return domain === "plugin" ? "pluginMutationPendingKeys" : "skillMutationPendingKeys";
}

function mutationErrorField(
  domain: MutationDomain,
): keyof Pick<WorkspaceRuntime, "skillMutationError" | "pluginMutationError"> {
  return domain === "plugin" ? "pluginMutationError" : "skillMutationError";
}

export function mutationPendingKey(action: string, id?: string): string {
  return id ? `${action}:${id}` : action;
}

export function setMutationPending(
  set: StoreSet,
  workspaceId: string,
  domain: MutationDomain,
  key: string,
  overrides?: Partial<WorkspaceRuntime>,
): void {
  const pendingField = mutationPendingField(domain);
  const errorField = mutationErrorField(domain);
  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: {
        ...s.workspaceRuntimeById[workspaceId],
        [errorField]: null,
        [pendingField]: {
          ...s.workspaceRuntimeById[workspaceId][pendingField],
          [key]: true,
        },
        ...(overrides ?? {}),
      },
    },
  }));
}

export function clearMutationPending(
  set: StoreSet,
  workspaceId: string,
  domain: MutationDomain,
  key: string,
  overrides?: Partial<WorkspaceRuntime>,
): void {
  const pendingField = mutationPendingField(domain);
  set((s) => {
    const pendingKeys = { ...s.workspaceRuntimeById[workspaceId][pendingField] };
    delete pendingKeys[key];
    return {
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...s.workspaceRuntimeById[workspaceId],
          [pendingField]: pendingKeys,
          ...(overrides ?? {}),
        },
      },
    };
  });
}

export function dismissMutationError(
  get: StoreGet,
  set: StoreSet,
  domain: MutationDomain,
  targetWorkspaceId?: string,
): void {
  const workspaceId = targetWorkspaceId ?? managementWorkspaceIdFor(get);
  if (!workspaceId) return;
  const errorField = mutationErrorField(domain);
  set((s) => {
    const runtime = s.workspaceRuntimeById[workspaceId];
    if (!runtime || runtime[errorField] === null) {
      return {};
    }
    return {
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...runtime,
          [errorField]: null,
        },
      },
    };
  });
}

export const workspacePathFor = (get: StoreGet, workspaceId: string): string | undefined =>
  ((get() as { workspaces?: Array<{ id: string; path: string }> }).workspaces ?? []).find(
    (workspace) => workspace.id === workspaceId,
  )?.path;

export const managementWorkspaceIdFor = (get: StoreGet): string | null => {
  const state = get();
  return resolveManagementWorkspaceId(state.workspaces ?? [], state.selectedWorkspaceId);
};

export function clearFailedMutationSend(
  set: StoreSet,
  workspaceId: string,
  key: string,
  detail: string,
  overrides?: Partial<WorkspaceRuntime>,
  domain: MutationDomain = "skill",
): void {
  const pendingField = mutationPendingField(domain);
  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: {
        ...s.workspaceRuntimeById[workspaceId],
        [pendingField]: (() => {
          const pendingKeys = { ...s.workspaceRuntimeById[workspaceId][pendingField] };
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
