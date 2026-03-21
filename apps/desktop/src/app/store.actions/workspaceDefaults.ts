import { defaultModelForProvider } from "@cowork/providers/catalog";
import type { OpenAiCompatibleProviderOptionsByProvider } from "@cowork/shared/openaiCompatibleOptions";

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
import type { ClientMessage, ProviderName } from "../../lib/wsProtocol";

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
import type { DraftModelSelection } from "../store.helpers/runtimeState";
import { normalizeWorkspaceUserProfile } from "../types";
import type { ThreadRecord, WorkspaceDefaultsPatch, WorkspaceRecord } from "../types";

export function createWorkspaceDefaultsActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "applyWorkspaceDefaultsToThread" | "updateWorkspaceDefaults"> {
  type DefaultsTargetState = {
    config: { provider?: unknown; model?: unknown } | null | undefined;
    sessionConfig: any;
    enableMcp: boolean | null | undefined;
  };

  const stringArrayEqual = (left: string[] | undefined, right: string[] | undefined): boolean => {
    if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
    return (left ?? []).every((value, index) => value === (right ?? [])[index]);
  };

  const userProfileEqual = (
    left: WorkspaceRecord["userProfile"] | undefined,
    right: WorkspaceRecord["userProfile"] | undefined,
  ): boolean => {
    const normalizedLeft = normalizeWorkspaceUserProfile(left);
    const normalizedRight = normalizeWorkspaceUserProfile(right);
    return (
      normalizedLeft.instructions === normalizedRight.instructions
      && normalizedLeft.work === normalizedRight.work
      && normalizedLeft.details === normalizedRight.details
    );
  };

  const buildApplySessionDefaultsMessage = (opts: {
    sessionId: string;
    current: DefaultsTargetState;
    desired: {
      provider?: ProviderName;
      model?: string;
      enableMcp?: boolean;
      backupsEnabled?: boolean;
      toolOutputOverflowChars?: number | null;
      preferredChildModel?: string;
      childModelRoutingMode?: WorkspaceRecord["defaultChildModelRoutingMode"];
      preferredChildModelRef?: string;
      allowedChildModelRefs?: string[];
      providerOptions?: WorkspaceRecord["providerOptions"];
      userName?: string;
      userProfile?: WorkspaceRecord["userProfile"];
    };
  }): ClientMessage | null => {
    const configPatch: NonNullable<Extract<ClientMessage, { type: "apply_session_defaults" }>["config"]> = {};
    const currentProvider =
      opts.current.config?.provider && isProviderName(opts.current.config.provider)
        ? opts.current.config.provider
        : undefined;
    const currentModel =
      typeof opts.current.config?.model === "string"
        ? opts.current.config.model.trim()
        : undefined;

    const providerChanged =
      opts.desired.provider !== undefined
      && !!opts.desired.model
      && (opts.desired.provider !== currentProvider || opts.desired.model !== currentModel);
    const enableMcpChanged =
      typeof opts.desired.enableMcp === "boolean"
      && opts.desired.enableMcp !== opts.current.enableMcp;

    if (
      typeof opts.desired.backupsEnabled === "boolean"
      && opts.desired.backupsEnabled !== opts.current.sessionConfig?.defaultBackupsEnabled
    ) {
      configPatch.backupsEnabled = opts.desired.backupsEnabled;
    }

    const currentDefaultToolOutputOverflow = opts.current.sessionConfig?.defaultToolOutputOverflowChars;
    if (opts.desired.toolOutputOverflowChars !== currentDefaultToolOutputOverflow) {
      if (opts.desired.toolOutputOverflowChars !== undefined) {
        configPatch.toolOutputOverflowChars = opts.desired.toolOutputOverflowChars;
      } else if (currentDefaultToolOutputOverflow !== undefined) {
        configPatch.clearToolOutputOverflowChars = true;
      }
    }

    if (
      opts.desired.childModelRoutingMode !== "cross-provider-allowlist"
      && opts.desired.preferredChildModel
      && opts.desired.preferredChildModel !== opts.current.sessionConfig?.preferredChildModel
    ) {
      configPatch.preferredChildModel = opts.desired.preferredChildModel;
    }
    if (
      opts.desired.childModelRoutingMode
      && opts.desired.childModelRoutingMode !== opts.current.sessionConfig?.childModelRoutingMode
    ) {
      configPatch.childModelRoutingMode = opts.desired.childModelRoutingMode;
    }
    if (
      opts.desired.preferredChildModelRef
      && opts.desired.preferredChildModelRef !== opts.current.sessionConfig?.preferredChildModelRef
    ) {
      configPatch.preferredChildModelRef = opts.desired.preferredChildModelRef;
    }
    if (
      opts.desired.allowedChildModelRefs
      && !stringArrayEqual(opts.desired.allowedChildModelRefs, opts.current.sessionConfig?.allowedChildModelRefs)
    ) {
      configPatch.allowedChildModelRefs = opts.desired.allowedChildModelRefs;
    }

    const desiredProviderOptions = normalizeWorkspaceProviderOptions(opts.desired.providerOptions);
    const currentProviderOptions = normalizeWorkspaceProviderOptions(opts.current.sessionConfig?.providerOptions);
    if (JSON.stringify(desiredProviderOptions ?? null) !== JSON.stringify(currentProviderOptions ?? null) && desiredProviderOptions) {
      configPatch.providerOptions = desiredProviderOptions as OpenAiCompatibleProviderOptionsByProvider;
    }

    if (
      opts.desired.userName !== undefined
      && opts.desired.userName !== opts.current.sessionConfig?.userName
    ) {
      configPatch.userName = opts.desired.userName;
    }
    if (
      opts.desired.userProfile !== undefined
      && !userProfileEqual(opts.desired.userProfile, opts.current.sessionConfig?.userProfile)
    ) {
      configPatch.userProfile = normalizeWorkspaceUserProfile(opts.desired.userProfile);
    }

    if (!providerChanged && !enableMcpChanged && Object.keys(configPatch).length === 0) {
      return null;
    }

    return {
      type: "apply_session_defaults",
      sessionId: opts.sessionId,
      ...(providerChanged ? { provider: opts.desired.provider, model: opts.desired.model } : {}),
      ...(enableMcpChanged ? { enableMcp: opts.desired.enableMcp } : {}),
      ...(Object.keys(configPatch).length > 0 ? { config: configPatch } : {}),
    };
  };

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
      draftModelSelection: { provider: ProviderName; model: string } | null = null,
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
      const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId) ?? null;
      const effectiveDraftModelSelection: DraftModelSelection | null =
        mode === "auto-resume"
          ? null
          : draftModelSelection ?? pendingApply?.draftModelSelection ?? null;
      if (mode !== "explicit" && (!rt.sessionConfig || rt.enableMcp === null)) {
        RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, {
          mode,
          draftModelSelection: effectiveDraftModelSelection,
        });
        return;
      }
      const harnessBackupsDefault = workspaceRuntime?.controlSessionConfig?.defaultBackupsEnabled;
      const harnessToolOutputOverflowChars = workspaceRuntime?.controlSessionConfig?.defaultToolOutputOverflowChars;

      // Defer model / provider / other config changes when the session is
      // busy — changing the model mid-turn is not safe.
      if (rt.busy) {
        RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, {
          mode,
          draftModelSelection: effectiveDraftModelSelection,
        });
        return;
      }
      RUNTIME.pendingWorkspaceDefaultApplyByThread.delete(threadId);

      const preserveSessionModel = mode === "auto-resume";

      const inferredProvider =
        !preserveSessionModel && ws.defaultProvider && isProviderName(ws.defaultProvider)
          ? ws.defaultProvider
          : isProviderName((rt.config as any)?.provider)
            ? ((rt.config as any).provider as ProviderName)
            : "google";

      let provider = inferredProvider;
      const liveDefaultModel = get().providerDefaultModelByProvider[provider]?.trim() || "";
      let model = (
        preserveSessionModel
          ? rt.config?.model?.trim()
          : ws.defaultModel?.trim() || liveDefaultModel || rt.config?.model?.trim() || ""
      ) || undefined;

      if (!preserveSessionModel && effectiveDraftModelSelection) {
        const p = effectiveDraftModelSelection.provider;
        const m = effectiveDraftModelSelection.model.trim();
        if (isProviderName(p) && m) {
          provider = p;
          model = m;
        }
      }
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
      const desiredEnableMcp = mode === "explicit"
        ? ws.defaultEnableMcp
        : (workspaceRuntime?.controlEnableMcp ?? ws.defaultEnableMcp);
      const message = buildApplySessionDefaultsMessage({
        sessionId: rt.sessionId,
        current: {
          config: rt.config,
          sessionConfig: rt.sessionConfig,
          enableMcp: rt.enableMcp,
        },
        desired: {
          ...(!preserveSessionModel && provider && model ? { provider, model } : {}),
          enableMcp: desiredEnableMcp,
          ...(typeof (mode === "explicit" ? ws.defaultBackupsEnabled : harnessBackupsDefault) === "boolean"
            ? { backupsEnabled: mode === "explicit" ? ws.defaultBackupsEnabled : harnessBackupsDefault }
            : {}),
          ...(mode === "explicit"
            ? { toolOutputOverflowChars: ws.defaultToolOutputOverflowChars }
            : harnessToolOutputOverflowChars !== undefined
              ? { toolOutputOverflowChars: harnessToolOutputOverflowChars }
              : {}),
          ...(preferredChildModel ? { preferredChildModel } : {}),
          ...(childModelRoutingMode ? { childModelRoutingMode } : {}),
          ...(preferredChildModelRef ? { preferredChildModelRef } : {}),
          ...(allowedChildModelRefs ? { allowedChildModelRefs } : {}),
          ...(providerOptions ? { providerOptions } : {}),
          ...(userName !== undefined ? { userName } : {}),
          ...(userProfile !== undefined ? { userProfile } : {}),
        },
      });
      if (!message) {
        return;
      }

      const ok = sendThread(get, threadId, () => message);
      if (ok) {
        appendThreadTranscript(threadId, "client", message);
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
      const currentWorkspaceRuntime = get().workspaceRuntimeById[workspaceId];
      const controlMessage = controlReady && currentWorkspaceRuntime?.controlSessionId
        ? buildApplySessionDefaultsMessage({
            sessionId: currentWorkspaceRuntime.controlSessionId,
            current: {
              config: currentWorkspaceRuntime.controlConfig,
              sessionConfig: currentWorkspaceRuntime.controlSessionConfig,
              enableMcp: currentWorkspaceRuntime.controlEnableMcp,
            },
            desired: {
              provider,
              model,
              enableMcp: nextWorkspace.defaultEnableMcp,
              backupsEnabled: nextWorkspace.defaultBackupsEnabled,
              toolOutputOverflowChars,
              ...(preferredChildModel ? { preferredChildModel } : {}),
              childModelRoutingMode,
              ...(preferredChildModelRef ? { preferredChildModelRef } : {}),
              allowedChildModelRefs,
              ...(providerOptions ? { providerOptions } : {}),
              ...(userName !== undefined ? { userName } : {}),
              ...(userProfile !== undefined ? { userProfile } : {}),
            },
          })
        : null;

      const persisted = controlReady
        ? (!controlMessage || sendControl(get, workspaceId, () => controlMessage))
        : false;

      if (!persisted) {
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
