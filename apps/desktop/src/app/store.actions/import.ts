import type {
  ConversationImportSource,
  ConversationPreviewItem,
  ConversationSourceCandidate,
  ConversationSourceRequest,
  ConversationWorkspaceMappingInput,
  ConversationWorkspaceMappingsValidateResult,
  ImportableItem,
  ImportableKind,
  ImportSource,
  ProviderName,
} from "../../lib/wsProtocol";
import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  operationKey,
  requestJsonRpcControl,
  requestJsonRpcControlEvent,
  requestWorkspaceSessions,
  runAcknowledgedOperation,
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

type ConversationSourceSelectionParams = {
  sources?: ConversationSourceRequest[];
  includeCodex?: boolean;
  includeClaudeCode?: boolean;
  includeCowork?: boolean;
  explicitPaths?: string[];
};

type ConversationImportResult = Awaited<ReturnType<AppStoreActions["importConversations"]>>;

export function createImportActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "listImportable"
  | "importPlugin"
  | "importSkill"
  | "listConversationImportSources"
  | "previewConversationImports"
  | "validateConversationWorkspaceMappings"
  | "importConversations"
> {
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

  const requestConversationImport = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    const workspaceId = managementWorkspaceIdFor(get);
    if (!workspaceId) throw new Error("No workspace is available for conversation import.");
    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);
    return (await requestJsonRpcControl(get, set, workspaceId, method, params)) as T;
  };

  return {
    listConversationImportSources: async (params: ConversationSourceSelectionParams = {}) =>
      await requestConversationImport<{ sources: ConversationSourceCandidate[] }>(
        "cowork/conversationImport/sources/list",
        params,
      ),

    previewConversationImports: async (
      params: ConversationSourceSelectionParams & {
        limit?: number;
        includeArchived?: boolean;
      } = {},
    ) =>
      await requestConversationImport<{ conversations: ConversationPreviewItem[] }>(
        "cowork/conversationImport/preview",
        params,
      ),

    validateConversationWorkspaceMappings: async (params: {
      mappings: Record<string, ConversationWorkspaceMappingInput>;
    }) =>
      await requestConversationImport<ConversationWorkspaceMappingsValidateResult>(
        "cowork/conversationImport/workspaceMappings/validate",
        params,
      ),

    importConversations: async (
      params: ConversationSourceSelectionParams & {
        selected: Array<{ source: ConversationImportSource; fingerprint: string }>;
        mappings?: Record<string, ConversationWorkspaceMappingInput>;
        defaultProvider?: ProviderName;
        defaultModel?: string;
        mode?: "skip-existing";
        includeArchived?: boolean;
      },
    ) => {
      const result = await requestConversationImport<ConversationImportResult>(
        "cowork/conversationImport/import",
        params,
      );
      const workspaceIds = new Set<string>();
      for (const imported of result.imported) {
        const workspaceId =
          imported.workspaceId ??
          get().workspaces.find((workspace) => workspace.path === imported.workspacePath)?.id;
        if (workspaceId) workspaceIds.add(workspaceId);
      }
      for (const created of result.createdWorkspaces) {
        if (get().workspaces.some((workspace) => workspace.id === created.workspaceId)) {
          workspaceIds.add(created.workspaceId);
        }
      }
      if (workspaceIds.size === 0) {
        const workspaceId = managementWorkspaceIdFor(get);
        if (workspaceId) workspaceIds.add(workspaceId);
      }
      await Promise.all(
        [...workspaceIds].map((workspaceId) => requestWorkspaceSessions(get, set, workspaceId)),
      );
      return result;
    },

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
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("import", "plugin", item.source, item.id, targetScope),
        label: "Import plugin",
        errorTitle: "Plugin not imported",
        errorMessage: "Unable to import plugin.",
        repairAction: "Review the import source and target, then retry.",
        execute: async () => {
          const workspaceId = managementWorkspaceIdFor(get);
          if (!workspaceId) {
            throw new Error("Add or select a workspace before importing a plugin.");
          }
          const cwd = workspacePathFor(get, workspaceId);
          const pendingKey = itemPendingKey(item, targetScope);
          setItemPending(workspaceId, pendingKey, true);
          try {
            await ensureServerRunning(get, set, workspaceId);
            ensureControlSocket(get, set, workspaceId);
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
            if (!ok) {
              const detail = rpcError.message?.trim() || "Unable to import plugin.";
              setImportState(workspaceId, importKey(item.source, "plugin"), { error: detail });
              throw new Error(detail);
            }
            if (targetScope === "user") {
              await refreshSharedWorkspaceState(get, set, workspaceId);
            }
            // Refresh the list so installed indicators update.
            await get().listImportable(item.source, "plugin");
          } finally {
            setItemPending(workspaceId, pendingKey, false);
          }
        },
      });
    },

    importSkill: async (item: ImportableItem, targetScope: "workspace" | "user") => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("import", "skill", item.source, item.id, targetScope),
        label: "Import skill",
        errorTitle: "Skill not imported",
        errorMessage: "Unable to import skill.",
        repairAction: "Review the import source and target, then retry.",
        execute: async () => {
          const workspaceId = managementWorkspaceIdFor(get);
          if (!workspaceId) {
            throw new Error("Add or select a workspace before importing a skill.");
          }
          const cwd = workspacePathFor(get, workspaceId);
          const pendingKey = itemPendingKey(item, targetScope);
          setItemPending(workspaceId, pendingKey, true);
          try {
            await ensureServerRunning(get, set, workspaceId);
            ensureControlSocket(get, set, workspaceId);
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
            if (!ok) {
              const detail = rpcError.message?.trim() || "Unable to import skill.";
              setImportState(workspaceId, importKey(item.source, "skill"), { error: detail });
              throw new Error(detail);
            }
            if (targetScope === "user") {
              await refreshSharedWorkspaceState(get, set, workspaceId);
            }
            await get().listImportable(item.source, "skill");
          } finally {
            setItemPending(workspaceId, pendingKey, false);
          }
        },
      });
    },
  };
}
