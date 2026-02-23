import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";

import {
  deleteTranscript,
  listDirectory,
  loadState,
  pickWorkspaceDirectory,
  readTranscript,
  stopWorkspaceServer,
  openPath,
  revealPath,
  copyPath,
  createDirectory,
  renamePath,
  trashPath,
} from "../../lib/desktopCommands";
import type { ProviderName } from "../../lib/wsProtocol";

import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  RUNTIME,
  appendThreadTranscript,
  basename,
  buildContextPreamble,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  isProviderName,
  makeId,
  mapTranscriptToFeed,
  normalizeProviderChoice,
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  sendControl,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  truncateTitle,
} from "../store.helpers";
import type { ThreadRecord, WorkspaceRecord } from "../types";

export function createWorkspaceDefaultsActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "applyWorkspaceDefaultsToThread" | "updateWorkspaceDefaults"> {
  return {
    applyWorkspaceDefaultsToThread: async (threadId: string) => {
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
      const ws = get().workspaces.find((w) => w.id === thread.workspaceId);
      if (!ws) return;
      const rt = get().threadRuntimeById[threadId];
      if (!rt?.sessionId) return;
      if (rt.busy) {
        RUNTIME.pendingWorkspaceDefaultApplyThreadIds.add(threadId);
        return;
      }
      RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(threadId);
  
      const inferredProvider =
        ws.defaultProvider && isProviderName(ws.defaultProvider)
          ? ws.defaultProvider
          : isProviderName((rt.config as any)?.provider)
            ? ((rt.config as any).provider as ProviderName)
            : "google";
  
      const provider = normalizeProviderChoice(inferredProvider);
      const model = (ws.defaultModel?.trim() || rt.config?.model?.trim() || "") || undefined;
      const subAgentModel =
        (ws.defaultSubAgentModel?.trim() || ws.defaultModel?.trim() || rt.sessionConfig?.subAgentModel?.trim() || "") || undefined;
  
      if (provider && model) {
        const ok = sendThread(get, threadId, (sessionId) => ({
          type: "set_model",
          sessionId,
          provider,
          model,
        }));
        if (ok) appendThreadTranscript(threadId, "client", { type: "set_model", sessionId: rt.sessionId, provider, model });
      }

      if (subAgentModel) {
        const okConfig = sendThread(get, threadId, (sessionId) => ({
          type: "set_config",
          sessionId,
          config: {
            subAgentModel,
          },
        }));
        if (okConfig) {
          appendThreadTranscript(threadId, "client", {
            type: "set_config",
            sessionId: rt.sessionId,
            config: { subAgentModel },
          });
        }
      }
  
      const okMcp = sendThread(get, threadId, (sessionId) => ({
        type: "set_enable_mcp",
        sessionId,
        enableMcp: ws.defaultEnableMcp,
      }));
      if (okMcp) {
        appendThreadTranscript(threadId, "client", { type: "set_enable_mcp", sessionId: rt.sessionId, enableMcp: ws.defaultEnableMcp });
      }
    },
  

    updateWorkspaceDefaults: async (workspaceId, patch) => {
      set((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, ...patch } : w)),
      }));
      await persistNow(get);

      const shouldSyncCoreSettings =
        patch.defaultProvider !== undefined ||
        patch.defaultModel !== undefined ||
        patch.defaultSubAgentModel !== undefined ||
        patch.defaultEnableMcp !== undefined;
      if (!shouldSyncCoreSettings) {
        return;
      }

      const workspace = get().workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return;

      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const provider = normalizeProviderChoice(
        workspace.defaultProvider && isProviderName(workspace.defaultProvider)
          ? workspace.defaultProvider
          : "google"
      );
      const model = workspace.defaultModel?.trim() || defaultModelForProvider(provider);
      const subAgentModel = workspace.defaultSubAgentModel?.trim() || model;

      const modelPersisted = sendControl(get, workspaceId, (sessionId) => ({
        type: "set_model",
        sessionId,
        provider,
        model,
      }));
      const subAgentPersisted = sendControl(get, workspaceId, (sessionId) => ({
        type: "set_config",
        sessionId,
        config: {
          subAgentModel,
        },
      }));
      const mcpPersisted = sendControl(get, workspaceId, (sessionId) => ({
        type: "set_enable_mcp",
        sessionId,
        enableMcp: workspace.defaultEnableMcp,
      }));

      if (!modelPersisted || !subAgentPersisted || !mcpPersisted) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Workspace settings partially applied",
            detail: "Control session is not fully connected yet. Reopen the workspace settings to retry.",
          }),
        }));
      }

      const threadIds = get()
        .threads.filter((thread) => thread.workspaceId === workspaceId)
        .map((thread) => thread.id);
      for (const threadId of threadIds) {
        void get().applyWorkspaceDefaultsToThread(threadId);
      }
    },
  
  };
}
