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
  waitForControlSession,
} from "../store.helpers";
import { mergeWorkspaceProviderOptions, normalizeWorkspaceProviderOptions } from "../openaiCompatibleProviderOptions";
import { normalizeWorkspaceUserProfile } from "../types";
import type { ThreadRecord, WorkspaceDefaultsPatch, WorkspaceRecord } from "../types";

export function createWorkspaceDefaultsActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "applyWorkspaceDefaultsToThread" | "updateWorkspaceDefaults"> {
  const resolveWorkspaceDefaults = (workspaceId: string): WorkspaceRecord | null => {
    const workspace = get().workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      return null;
    }

    const runtime = get().workspaceRuntimeById[workspaceId];
    const controlConfig = runtime?.controlConfig as { provider?: unknown; model?: unknown } | null | undefined;
    const controlSessionConfig = runtime?.controlSessionConfig;
    const provider =
      workspace.defaultProvider && isProviderName(workspace.defaultProvider)
        ? workspace.defaultProvider
        : controlConfig?.provider && isProviderName(controlConfig.provider)
          ? controlConfig.provider
          : "google";
    const liveDefaultModel = get().providerDefaultModelByProvider[provider]?.trim() || "";
    const controlModel = typeof controlConfig?.model === "string" ? controlConfig.model.trim() : "";
    const defaultModel = workspace.defaultModel?.trim() || controlModel || liveDefaultModel || defaultModelForProvider(provider);
    const defaultPreferredChildModel =
      controlSessionConfig?.preferredChildModel?.trim()
      || workspace.defaultPreferredChildModel?.trim()
      || defaultModel;
    const defaultPreferredChildModelRef =
      controlSessionConfig?.preferredChildModelRef?.trim()
      || workspace.defaultPreferredChildModelRef?.trim()
      || (defaultPreferredChildModel ? `${provider}:${defaultPreferredChildModel}` : undefined);

    return {
      ...workspace,
      defaultProvider: provider,
      defaultModel,
      defaultPreferredChildModel,
      defaultChildModelRoutingMode: controlSessionConfig?.childModelRoutingMode ?? workspace.defaultChildModelRoutingMode ?? "same-provider",
      defaultPreferredChildModelRef,
      defaultAllowedChildModelRefs: controlSessionConfig?.allowedChildModelRefs ?? workspace.defaultAllowedChildModelRefs ?? [],
      defaultToolOutputOverflowChars: controlSessionConfig?.defaultToolOutputOverflowChars ?? workspace.defaultToolOutputOverflowChars,
      providerOptions: normalizeWorkspaceProviderOptions(controlSessionConfig?.providerOptions) ?? workspace.providerOptions,
      userName: typeof controlSessionConfig?.userName === "string" ? controlSessionConfig.userName : workspace.userName,
      userProfile: controlSessionConfig?.userProfile
        ? normalizeWorkspaceUserProfile(controlSessionConfig.userProfile)
        : workspace.userProfile
          ? normalizeWorkspaceUserProfile(workspace.userProfile)
          : undefined,
      defaultEnableMcp: typeof runtime?.controlEnableMcp === "boolean" ? runtime.controlEnableMcp : workspace.defaultEnableMcp,
      defaultBackupsEnabled:
        typeof controlSessionConfig?.defaultBackupsEnabled === "boolean"
          ? controlSessionConfig.defaultBackupsEnabled
          : workspace.defaultBackupsEnabled,
    };
  };

  const applyWorkspacePatch = (
    workspace: WorkspaceRecord,
    patch: WorkspaceDefaultsPatch,
  ): WorkspaceRecord => {
    const { clearDefaultToolOutputOverflowChars, userProfile: userProfilePatch, ...workspacePatch } = patch;
    return {
      ...workspace,
      ...workspacePatch,
      ...(clearDefaultToolOutputOverflowChars ? { defaultToolOutputOverflowChars: undefined } : {}),
      ...(workspacePatch.providerOptions !== undefined
        ? {
            providerOptions: mergeWorkspaceProviderOptions(workspace.providerOptions, workspacePatch.providerOptions),
          }
        : {}),
      ...(userProfilePatch !== undefined
        ? {
            userProfile: {
              ...normalizeWorkspaceUserProfile(workspace.userProfile),
              ...userProfilePatch,
            },
          }
        : {}),
    };
  };

  return {
    applyWorkspaceDefaultsToThread: async (
      threadId: string,
      mode: "auto" | "auto-resume" | "explicit" = "explicit",
    ) => {
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
      const ws = (
        mode === "explicit"
          ? get().workspaces.find((entry) => entry.id === thread.workspaceId) ?? null
          : resolveWorkspaceDefaults(thread.workspaceId)
      );
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
        RUNTIME.pendingWorkspaceDefaultApplyModeByThread.set(threadId, mode);
        return;
      }
      RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(threadId);
      RUNTIME.pendingWorkspaceDefaultApplyModeByThread.delete(threadId);

      const preserveSessionModel = mode === "auto-resume";

      const inferredProvider =
        !preserveSessionModel && ws.defaultProvider && isProviderName(ws.defaultProvider)
          ? ws.defaultProvider
          : isProviderName((rt.config as any)?.provider)
            ? ((rt.config as any).provider as ProviderName)
            : "google";

      const provider = inferredProvider;
      const liveDefaultModel = get().providerDefaultModelByProvider[provider]?.trim() || "";
      const model = (
        preserveSessionModel
          ? rt.config?.model?.trim()
          : ws.defaultModel?.trim() || liveDefaultModel || rt.config?.model?.trim() || ""
      ) || undefined;
      const preferredChildModel = (
        preserveSessionModel
          ? rt.sessionConfig?.preferredChildModel?.trim() || rt.config?.model?.trim() || ""
          : ws.defaultPreferredChildModel?.trim() || ws.defaultModel?.trim() || rt.sessionConfig?.preferredChildModel?.trim() || ""
      ) || undefined;
      const childModelRoutingMode =
        preserveSessionModel
          ? rt.sessionConfig?.childModelRoutingMode ?? "same-provider"
          : ws.defaultChildModelRoutingMode
            ?? rt.sessionConfig?.childModelRoutingMode
            ?? "same-provider";
      const preferredChildModelRef =
        (
          preserveSessionModel
            ? rt.sessionConfig?.preferredChildModelRef?.trim()
            : ws.defaultPreferredChildModelRef?.trim() || rt.sessionConfig?.preferredChildModelRef?.trim()
        )
        || (provider && preferredChildModel ? `${provider}:${preferredChildModel}` : undefined);
      const allowedChildModelRefs =
        preserveSessionModel
          ? rt.sessionConfig?.allowedChildModelRefs ?? []
          : ws.defaultAllowedChildModelRefs
            ?? rt.sessionConfig?.allowedChildModelRefs
            ?? [];
      const providerOptions = ws.providerOptions;
      const userName = ws.userName;
      const userProfile = ws.userProfile ? normalizeWorkspaceUserProfile(ws.userProfile) : undefined;
      const hasProfileDefaults = userName !== undefined || userProfile !== undefined;

      if (!preserveSessionModel && provider && model) {
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
        enableMcp: mode === "explicit"
          ? ws.defaultEnableMcp
          : (workspaceRuntime?.controlEnableMcp ?? ws.defaultEnableMcp),
      }));
      if (okMcp) {
        appendThreadTranscript(threadId, "client", {
          type: "set_enable_mcp",
          sessionId: rt.sessionId,
          enableMcp: mode === "explicit"
            ? ws.defaultEnableMcp
            : (workspaceRuntime?.controlEnableMcp ?? ws.defaultEnableMcp),
        });
      }
    },
  

    updateWorkspaceDefaults: async (workspaceId, patch: WorkspaceDefaultsPatch) => {
      const optimisticWorkspace =
        resolveWorkspaceDefaults(workspaceId)
        ?? get().workspaces.find((workspace) => workspace.id === workspaceId);
      if (!optimisticWorkspace) {
        return;
      }

      set((s) => ({
        workspaces: s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w;
          return applyWorkspacePatch(optimisticWorkspace, patch);
        }),
      }));
      await persistNow(get);

      const { clearDefaultToolOutputOverflowChars, userProfile: userProfilePatch, ...workspacePatch } = patch;
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

      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
      const controlReady = await waitForControlSession(get, workspaceId);
      const workspace = controlReady
        ? resolveWorkspaceDefaults(workspaceId)
        : get().workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return;
      const nextWorkspace = applyWorkspacePatch(workspace, patch);

      set((s) => ({
        workspaces: s.workspaces.map((entry) => (
          entry.id === workspaceId ? nextWorkspace : entry
        )),
      }));
      await persistNow(get);

      const provider = (
        nextWorkspace.defaultProvider && isProviderName(nextWorkspace.defaultProvider)
          ? nextWorkspace.defaultProvider
          : "google"
      );
      const liveDefaultModel = get().providerDefaultModelByProvider[provider]?.trim() || "";
      const model = nextWorkspace.defaultModel?.trim() || liveDefaultModel || defaultModelForProvider(provider);
      const preferredChildModel = nextWorkspace.defaultPreferredChildModel?.trim() || model || "";
      const childModelRoutingMode = nextWorkspace.defaultChildModelRoutingMode ?? "same-provider";
      const preferredChildModelRef = nextWorkspace.defaultPreferredChildModelRef?.trim() || (preferredChildModel ? `${provider}:${preferredChildModel}` : "");
      const allowedChildModelRefs = nextWorkspace.defaultAllowedChildModelRefs ?? [];
      const toolOutputOverflowChars = nextWorkspace.defaultToolOutputOverflowChars;
      const providerOptions = nextWorkspace.providerOptions;
      const userName = nextWorkspace.userName;
      const userProfile = nextWorkspace.userProfile ? normalizeWorkspaceUserProfile(nextWorkspace.userProfile) : undefined;
      const clearToolOutputOverflowChars = clearDefaultToolOutputOverflowChars === true;

      const modelPersisted = controlReady && model
        ? sendControl(get, workspaceId, (sessionId) => ({
            type: "set_model",
            sessionId,
            provider,
            model,
          }))
        : false;
      const subAgentPersisted = controlReady && sendControl(get, workspaceId, (sessionId) => ({
        type: "set_config",
        sessionId,
        config: {
          backupsEnabled: nextWorkspace.defaultBackupsEnabled,
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
      const mcpPersisted = controlReady && sendControl(get, workspaceId, (sessionId) => ({
        type: "set_enable_mcp",
        sessionId,
        enableMcp: nextWorkspace.defaultEnableMcp,
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
