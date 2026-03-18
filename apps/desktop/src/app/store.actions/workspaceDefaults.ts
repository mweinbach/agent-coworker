import { defaultModelForProvider } from "@cowork/providers/catalog";
import type { OpenAiCompatibleProviderOptionsByProvider } from "@cowork/shared/openaiCompatibleOptions";
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
import { mergeWorkspaceProviderOptions } from "../openaiCompatibleProviderOptions";
import { normalizeWorkspaceUserProfile } from "../types";
import type { ThreadRecord, WorkspaceDefaultsPatch, WorkspaceRecord } from "../types";

export function createWorkspaceDefaultsActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "applyWorkspaceDefaultsToThread" | "updateWorkspaceDefaults"> {
  return {
    applyWorkspaceDefaultsToThread: async (threadId: string, mode: "auto" | "explicit" = "explicit") => {
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
      const ws = get().workspaces.find((w) => w.id === thread.workspaceId);
      if (!ws) return;
      const rt = get().threadRuntimeById[threadId];
      if (!rt?.sessionId) return;
      const workspaceRuntime = get().workspaceRuntimeById[thread.workspaceId];
      const harnessBackupsDefault = workspaceRuntime?.controlSessionConfig?.defaultBackupsEnabled;
      const harnessToolOutputOverflowChars = workspaceRuntime?.controlSessionConfig?.defaultToolOutputOverflowChars;
      const backupsEnabled = mode === "explicit" ? ws.defaultBackupsEnabled : harnessBackupsDefault;
      const toolOutputOverflowChars = mode === "explicit" ? ws.defaultToolOutputOverflowChars : harnessToolOutputOverflowChars;
      const clearToolOutputOverflowChars =
        mode === "explicit"
        && ws.defaultToolOutputOverflowChars === undefined
        && rt.sessionConfig?.defaultToolOutputOverflowChars !== undefined;

      // Explicit user-driven default changes should still hit live sessions
      // immediately. Automatic connect-time sync only trusts the harness-
      // sourced default once the control session has provided it.
      if (typeof backupsEnabled === "boolean" || toolOutputOverflowChars !== undefined || clearToolOutputOverflowChars) {
        const configPatch = {
          ...(typeof backupsEnabled === "boolean" ? { backupsEnabled } : {}),
          ...(toolOutputOverflowChars !== undefined
            ? { toolOutputOverflowChars }
            : clearToolOutputOverflowChars
              ? { clearToolOutputOverflowChars: true }
              : {}),
        };
        const okBackups = sendThread(get, threadId, (sessionId) => ({
          type: "set_config",
          sessionId,
          config: configPatch,
        }));
        if (okBackups) {
          appendThreadTranscript(threadId, "client", {
            type: "set_config",
            sessionId: rt.sessionId,
            config: configPatch,
          });
        }
      }

      // Defer model / provider / other config changes when the session is
      // busy — changing the model mid-turn is not safe.
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

      const provider = inferredProvider;
      const liveDefaultModel = get().providerDefaultModelByProvider[provider]?.trim() || "";
      const model = (ws.defaultModel?.trim() || liveDefaultModel || rt.config?.model?.trim() || "") || undefined;
      const preferredChildModel =
        (ws.defaultPreferredChildModel?.trim() || ws.defaultModel?.trim() || rt.sessionConfig?.preferredChildModel?.trim() || "") || undefined;
      const childModelRoutingMode =
        ws.defaultChildModelRoutingMode
        ?? rt.sessionConfig?.childModelRoutingMode
        ?? "same-provider";
      const preferredChildModelRef =
        ws.defaultPreferredChildModelRef?.trim()
        || rt.sessionConfig?.preferredChildModelRef?.trim()
        || (provider && preferredChildModel ? `${provider}:${preferredChildModel}` : undefined);
      const allowedChildModelRefs =
        ws.defaultAllowedChildModelRefs
        ?? rt.sessionConfig?.allowedChildModelRefs
        ?? [];
      const providerOptions = ws.providerOptions;
      const userName = ws.userName;
      const userProfile = ws.userProfile ? normalizeWorkspaceUserProfile(ws.userProfile) : undefined;
      const hasProfileDefaults = userName !== undefined || userProfile !== undefined;

      if (provider && model) {
        const ok = sendThread(get, threadId, (sessionId) => ({
          type: "set_model",
          sessionId,
          provider,
          model,
        }));
        if (ok) appendThreadTranscript(threadId, "client", { type: "set_model", sessionId: rt.sessionId, provider, model });
      }

      if (preferredChildModel || preferredChildModelRef || providerOptions || hasProfileDefaults) {
        const okConfig = sendThread(get, threadId, (sessionId) => ({
          type: "set_config",
          sessionId,
          config: {
            ...(preferredChildModel ? { preferredChildModel } : {}),
            childModelRoutingMode,
            ...(preferredChildModelRef ? { preferredChildModelRef } : {}),
            allowedChildModelRefs,
            ...(providerOptions ? { providerOptions: providerOptions as OpenAiCompatibleProviderOptionsByProvider } : {}),
            ...(userName !== undefined ? { userName } : {}),
            ...(userProfile !== undefined ? { userProfile } : {}),
          },
        }));
        if (okConfig) {
          appendThreadTranscript(threadId, "client", {
            type: "set_config",
            sessionId: rt.sessionId,
            config: {
              ...(preferredChildModel ? { preferredChildModel } : {}),
              childModelRoutingMode,
              ...(preferredChildModelRef ? { preferredChildModelRef } : {}),
              allowedChildModelRefs,
              ...(providerOptions ? { providerOptions } : {}),
              ...(userName !== undefined ? { userName } : {}),
              ...(userProfile !== undefined ? { userProfile } : {}),
            },
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
  

    updateWorkspaceDefaults: async (workspaceId, patch: WorkspaceDefaultsPatch) => {
      const { clearDefaultToolOutputOverflowChars, userProfile: userProfilePatch, ...workspacePatch } = patch;
      set((s) => ({
        workspaces: s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          return {
            ...w,
            ...workspacePatch,
            ...(clearDefaultToolOutputOverflowChars ? { defaultToolOutputOverflowChars: undefined } : {}),
            ...(workspacePatch.providerOptions !== undefined
              ? {
                  providerOptions: mergeWorkspaceProviderOptions(w.providerOptions, workspacePatch.providerOptions),
                }
              : {}),
            ...(userProfilePatch !== undefined
              ? {
                  userProfile: {
                    ...normalizeWorkspaceUserProfile(w.userProfile),
                    ...userProfilePatch,
                  },
                }
              : {}),
          };
        }),
      }));
      await persistNow(get);

      const shouldSyncCoreSettings =
        workspacePatch.defaultProvider !== undefined ||
        workspacePatch.defaultModel !== undefined ||
        workspacePatch.defaultPreferredChildModel !== undefined ||
        workspacePatch.defaultChildModelRoutingMode !== undefined ||
        workspacePatch.defaultPreferredChildModelRef !== undefined ||
        workspacePatch.defaultAllowedChildModelRefs !== undefined ||
        workspacePatch.defaultToolOutputOverflowChars !== undefined ||
        clearDefaultToolOutputOverflowChars === true ||
        workspacePatch.defaultEnableMcp !== undefined ||
        workspacePatch.defaultBackupsEnabled !== undefined ||
        workspacePatch.providerOptions !== undefined ||
        workspacePatch.userName !== undefined ||
        userProfilePatch !== undefined;
      if (!shouldSyncCoreSettings) {
        return;
      }

      const workspace = get().workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return;

      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);

      const provider = (
        workspace.defaultProvider && isProviderName(workspace.defaultProvider)
          ? workspace.defaultProvider
          : "google"
      );
      const liveDefaultModel = get().providerDefaultModelByProvider[provider]?.trim() || "";
      const model = workspace.defaultModel?.trim() || liveDefaultModel || defaultModelForProvider(provider);
      const preferredChildModel = workspace.defaultPreferredChildModel?.trim() || model || "";
      const childModelRoutingMode = workspace.defaultChildModelRoutingMode ?? "same-provider";
      const preferredChildModelRef = workspace.defaultPreferredChildModelRef?.trim() || (preferredChildModel ? `${provider}:${preferredChildModel}` : "");
      const allowedChildModelRefs = workspace.defaultAllowedChildModelRefs ?? [];
      const toolOutputOverflowChars = workspace.defaultToolOutputOverflowChars;
      const providerOptions = workspace.providerOptions;
      const userName = workspace.userName;
      const userProfile = workspace.userProfile ? normalizeWorkspaceUserProfile(workspace.userProfile) : undefined;
      const clearToolOutputOverflowChars = clearDefaultToolOutputOverflowChars === true;

      const modelPersisted = model
        ? sendControl(get, workspaceId, (sessionId) => ({
            type: "set_model",
            sessionId,
            provider,
            model,
          }))
        : false;
      const subAgentPersisted = sendControl(get, workspaceId, (sessionId) => ({
        type: "set_config",
        sessionId,
        config: {
          backupsEnabled: workspace.defaultBackupsEnabled,
          ...(preferredChildModel ? { preferredChildModel } : {}),
          childModelRoutingMode,
          ...(preferredChildModelRef ? { preferredChildModelRef } : {}),
          allowedChildModelRefs,
          ...(toolOutputOverflowChars !== undefined
            ? { toolOutputOverflowChars }
            : clearToolOutputOverflowChars
              ? { clearToolOutputOverflowChars: true }
              : {}),
          ...(providerOptions ? { providerOptions: providerOptions as OpenAiCompatibleProviderOptionsByProvider } : {}),
          ...(userName !== undefined ? { userName } : {}),
          ...(userProfile !== undefined ? { userProfile } : {}),
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
        void get().applyWorkspaceDefaultsToThread(threadId, "explicit");
      }
    },
  
  };
}
