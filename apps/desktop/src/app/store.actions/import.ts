import type { ImportableItem, ImportableKind, ImportSource } from "../../lib/wsProtocol";
import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  requestJsonRpcControlEvent,
  type StoreGet,
  type StoreSet,
} from "../store.helpers";
import {
  managementWorkspaceIdFor,
  refreshSharedWorkspaceState,
  workspacePathFor,
} from "./skillPluginHelpers";

function importKey(source: ImportSource, kind: ImportableKind): string {
  return `${source}:${kind}`;
}

function itemPendingKey(item: ImportableItem, targetScope: "workspace" | "user"): string {
  return `${item.kind}:${item.source}:${item.id}:${targetScope}`;
}

export function createImportActions(
  set: StoreSet,
  get: StoreGet,
): Pick<AppStoreActions, "listImportable" | "importPlugin" | "importSkill"> {
  const setImportState = (
    workspaceId: string,
    key: string,
    patch: Partial<{ loading: boolean; error: string | null }>,
  ) => {
    set((s) => {
      const rt = s.workspaceRuntimeById[workspaceId];
      if (!rt) return {};
      const existing = rt.importItemsByKey[key] ?? {
        items: [],
        homeExists: false,
        loading: false,
        error: null,
      };
      return {
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...rt,
            importItemsByKey: {
              ...rt.importItemsByKey,
              [key]: { ...existing, ...patch },
            },
          },
        },
      };
    });
  };

  const setItemPending = (workspaceId: string, key: string, pending: boolean) => {
    set((s) => {
      const rt = s.workspaceRuntimeById[workspaceId];
      if (!rt) return {};
      const next = { ...rt.importPendingKeys };
      if (pending) {
        next[key] = true;
      } else {
        delete next[key];
      }
      return {
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: { ...rt, importPendingKeys: next },
        },
      };
    });
  };

  return {
    listImportable: async (source: ImportSource, kind: ImportableKind) => {
      const workspaceId = managementWorkspaceIdFor(get);
      if (!workspaceId) return;
      const cwd = workspacePathFor(get, workspaceId);
      const key = importKey(source, kind);
      setImportState(workspaceId, key, { loading: true, error: null });
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const ok = await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/import/list", {
        cwd,
        source,
        kind,
      });
      if (!ok) {
        setImportState(workspaceId, key, {
          loading: false,
          error: `Unable to list importable ${kind}s from ${source}.`,
        });
      }
    },

    importPlugin: async (item: ImportableItem, targetScope: "workspace" | "user") => {
      const workspaceId = managementWorkspaceIdFor(get);
      if (!workspaceId) return;
      const cwd = workspacePathFor(get, workspaceId);
      const pendingKey = itemPendingKey(item, targetScope);
      setItemPending(workspaceId, pendingKey, true);
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/import/plugin",
        {
          cwd,
          source: item.source,
          sourcePath: item.sourcePath,
          conversionRequired: item.conversionRequired === true,
          targetScope,
        },
        rpcError,
      );
      setItemPending(workspaceId, pendingKey, false);
      if (!ok) {
        const detail = rpcError.message?.trim() || "Unable to import plugin.";
        setImportState(workspaceId, importKey(item.source, "plugin"), { error: detail });
        return;
      }
      if (targetScope === "user") {
        await refreshSharedWorkspaceState(get, set, workspaceId);
      }
      // Refresh the list so installed indicators update.
      await get().listImportable(item.source, "plugin");
    },

    importSkill: async (item: ImportableItem, targetScope: "workspace" | "user") => {
      const workspaceId = managementWorkspaceIdFor(get);
      if (!workspaceId) return;
      const cwd = workspacePathFor(get, workspaceId);
      const pendingKey = itemPendingKey(item, targetScope);
      setItemPending(workspaceId, pendingKey, true);
      const rpcError: { message?: string } = {};
      const ok = await requestJsonRpcControlEvent(
        get,
        set,
        workspaceId,
        "cowork/import/skill",
        {
          cwd,
          source: item.source,
          sourcePath: item.sourcePath,
          targetScope,
        },
        rpcError,
      );
      setItemPending(workspaceId, pendingKey, false);
      if (!ok) {
        const detail = rpcError.message?.trim() || "Unable to import skill.";
        setImportState(workspaceId, importKey(item.source, "skill"), { error: detail });
        return;
      }
      if (targetScope === "user") {
        await refreshSharedWorkspaceState(get, set, workspaceId);
      }
      await get().listImportable(item.source, "skill");
    },
  };
}
