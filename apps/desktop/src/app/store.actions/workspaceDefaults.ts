import { defaultModelForProvider } from "@cowork/providers/catalog";
import type { OpenAiCompatibleProviderOptionsByProvider } from "@cowork/shared/openaiCompatibleOptions";
import type { SessionConfigPatch } from "../../../../../src/server/protocol";
import type { ProviderName } from "../../lib/wsProtocol";
import {
  googleProviderOptionsForReasoningEffort,
  isGoogleReasoningEffortValue,
  isOpenAiReasoningEffortValue,
  mergeWorkspaceProviderOptions,
  mergeWorkspaceProviderOptionsPreservingSearchSettings,
  normalizeWorkspaceProviderOptions,
} from "../openaiCompatibleProviderOptions";
import {
  type AppStoreActions,
  appendThreadTranscript,
  ensureControlSocket,
  ensureServerRunning,
  isProviderName,
  makeId,
  nowIso,
  persistNow,
  prependPendingThreadMessageWithAttachments,
  pushNotification,
  RUNTIME,
  requestJsonRpcControlEvent,
  type StoreGet,
  type StoreSet,
  sendUserMessageToThread,
  shiftPendingThreadAttachments,
  shiftPendingThreadMessage,
  shiftPendingThreadReferences,
  waitForControlSession,
} from "../store.helpers";
import { requestJsonRpc } from "../store.helpers/jsonRpcSocket";
import type { DraftModelSelection } from "../store.helpers/runtimeState";
import {
  isOneOffChatWorkspace,
  normalizeWorkspaceUserProfile,
  type WorkspaceDefaultsPatch,
  type WorkspaceRecord,
} from "../types";
import { applyWorkspacePatch, copyWorkspaceSettings } from "./workspaceDefaultRecords";
import {
  applyGlobalMemoryDefaults,
  buildGlobalMemoryDefaultsPatch,
  hasGlobalMemoryDefaultsPatch,
  resolveControlApplyMemoryDefaults,
  resolveThreadApplyMemoryDefaults,
  resolveWorkspaceMemoryDefaultsFromControl,
} from "./workspaceMemoryDefaults";

export function createWorkspaceDefaultsActions(
  set: StoreSet,
  get: StoreGet,
): Pick<AppStoreActions, "applyWorkspaceDefaultsToThread" | "updateWorkspaceDefaults"> {
  type ApplySessionDefaultsMessage = {
    type: "apply_session_defaults";
    sessionId: string;
    provider?: ProviderName;
    model?: string;
    enableMcp?: boolean;
    config?: SessionConfigPatch;
  };
  type DefaultsTargetState = {
    config: { provider?: unknown; model?: unknown } | null | undefined;
    sessionConfig: Record<string, unknown> | null | undefined;
    enableMcp: boolean | null | undefined;
  };
  type ThreadJsonRpcApplyResult = {
    ok: boolean;
    errorMessage?: string;
  };
  class ThreadDefaultsApplyResponseError extends Error {}

  const stringArrayEqual = (left: string[] | undefined, right: string[] | undefined): boolean => {
    if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
    return (left ?? []).every((value, index) => value === (right ?? [])[index]);
  };

  const applyThreadJsonRpcResponseState = (
    threadId: string,
    sessionId: string,
    result: unknown,
  ): ThreadJsonRpcApplyResult => {
    const events = Array.isArray((result as { events?: unknown[] })?.events)
      ? (result as { events: unknown[] }).events
      : (result as { event?: unknown })?.event !== undefined
        ? [(result as { event: unknown }).event]
        : [];
    if (events.length === 0) {
      return { ok: true };
    }

    const unset = Symbol("thread-response-state-unset");
    let nextConfig: Record<string, unknown> | typeof unset = unset;
    let nextSessionConfig: Record<string, unknown> | typeof unset = unset;
    let nextEnableMcp: boolean | typeof unset = unset;
    let errorMessage: string | undefined;

    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const candidate = event as {
        type?: string;
        sessionId?: unknown;
        message?: unknown;
        config?: unknown;
        enableMcp?: unknown;
      };
      if (candidate.type === "error") {
        errorMessage =
          typeof candidate.message === "string" && candidate.message.trim()
            ? candidate.message
            : "Unable to apply workspace defaults to the active thread.";
        continue;
      }
      if (candidate.sessionId !== sessionId) {
        continue;
      }
      if (
        candidate.type === "config_updated" &&
        candidate.config &&
        typeof candidate.config === "object"
      ) {
        nextConfig = candidate.config as Record<string, unknown>;
        continue;
      }
      if (
        candidate.type === "session_config" &&
        candidate.config &&
        typeof candidate.config === "object"
      ) {
        nextSessionConfig = candidate.config as Record<string, unknown>;
        continue;
      }
      if (candidate.type === "session_settings" && typeof candidate.enableMcp === "boolean") {
        nextEnableMcp = candidate.enableMcp;
      }
    }

    if (nextConfig !== unset || nextSessionConfig !== unset || nextEnableMcp !== unset) {
      set((state) => {
        const runtime = state.threadRuntimeById[threadId];
        if (!runtime || runtime.sessionId !== sessionId) {
          return {};
        }
        return {
          threadRuntimeById: {
            ...state.threadRuntimeById,
            [threadId]: {
              ...runtime,
              ...(nextConfig !== unset ? { config: nextConfig as typeof runtime.config } : {}),
              ...(nextSessionConfig !== unset
                ? { sessionConfig: nextSessionConfig as typeof runtime.sessionConfig }
                : {}),
              ...(nextEnableMcp !== unset ? { enableMcp: nextEnableMcp } : {}),
            },
          },
        };
      });
    }

    return errorMessage ? { ok: false, errorMessage } : { ok: true };
  };

  const userProfileEqual = (
    left: WorkspaceRecord["userProfile"] | undefined,
    right: WorkspaceRecord["userProfile"] | undefined,
  ): boolean => {
    const normalizedLeft = normalizeWorkspaceUserProfile(left);
    const normalizedRight = normalizeWorkspaceUserProfile(right);
    return (
      normalizedLeft.instructions === normalizedRight.instructions &&
      normalizedLeft.work === normalizedRight.work &&
      normalizedLeft.details === normalizedRight.details
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
      advancedMemory?: boolean;
      memoryGenerationModel?: string | null;
      toolOutputOverflowChars?: number | null;
      preferredChildModel?: string;
      childModelRoutingMode?: WorkspaceRecord["defaultChildModelRoutingMode"];
      preferredChildModelRef?: string;
      allowedChildModelRefs?: string[];
      providerOptions?: WorkspaceRecord["providerOptions"];
      userName?: string;
      userProfile?: WorkspaceRecord["userProfile"];
      yolo?: boolean;
    };
  }): ApplySessionDefaultsMessage | null => {
    const configPatch: NonNullable<ApplySessionDefaultsMessage["config"]> = {};
    const currentSessionConfig = (opts.current.sessionConfig ?? {}) as {
      defaultBackupsEnabled?: boolean;
      advancedMemory?: boolean;
      memoryGenerationModel?: string;
      defaultToolOutputOverflowChars?: number | null;
      preferredChildModel?: string;
      childModelRoutingMode?: WorkspaceRecord["defaultChildModelRoutingMode"];
      preferredChildModelRef?: string;
      allowedChildModelRefs?: string[];
      providerOptions?: unknown;
      userName?: string;
      userProfile?: WorkspaceRecord["userProfile"];
      yolo?: boolean;
    };
    const currentProvider =
      opts.current.config?.provider && isProviderName(opts.current.config.provider)
        ? opts.current.config.provider
        : undefined;
    const currentModel =
      typeof opts.current.config?.model === "string" ? opts.current.config.model.trim() : undefined;

    const providerChanged =
      opts.desired.provider !== undefined &&
      !!opts.desired.model &&
      (opts.desired.provider !== currentProvider || opts.desired.model !== currentModel);
    const enableMcpChanged =
      typeof opts.desired.enableMcp === "boolean" &&
      opts.desired.enableMcp !== opts.current.enableMcp;

    if (
      typeof opts.desired.backupsEnabled === "boolean" &&
      opts.desired.backupsEnabled !== currentSessionConfig.defaultBackupsEnabled
    ) {
      configPatch.backupsEnabled = opts.desired.backupsEnabled;
    }

    if (typeof opts.desired.yolo === "boolean" && opts.desired.yolo !== currentSessionConfig.yolo) {
      configPatch.yolo = opts.desired.yolo;
    }

    if (
      typeof opts.desired.advancedMemory === "boolean" &&
      opts.desired.advancedMemory !== currentSessionConfig.advancedMemory
    ) {
      configPatch.advancedMemory = opts.desired.advancedMemory;
    }

    if (Object.hasOwn(opts.desired, "memoryGenerationModel")) {
      const currentMemoryGenerationModel =
        currentSessionConfig.memoryGenerationModel?.trim() || undefined;
      const desiredMemoryGenerationModel = opts.desired.memoryGenerationModel?.trim() || undefined;
      if (desiredMemoryGenerationModel !== currentMemoryGenerationModel) {
        if (desiredMemoryGenerationModel) {
          configPatch.memoryGenerationModel = desiredMemoryGenerationModel;
        } else if (currentMemoryGenerationModel !== undefined) {
          configPatch.clearMemoryGenerationModel = true;
        }
      }
    }

    const currentDefaultToolOutputOverflow = currentSessionConfig.defaultToolOutputOverflowChars;
    if (opts.desired.toolOutputOverflowChars !== currentDefaultToolOutputOverflow) {
      if (opts.desired.toolOutputOverflowChars !== undefined) {
        configPatch.toolOutputOverflowChars = opts.desired.toolOutputOverflowChars;
      } else if (currentDefaultToolOutputOverflow !== undefined) {
        configPatch.clearToolOutputOverflowChars = true;
      }
    }

    if (
      opts.desired.childModelRoutingMode !== "cross-provider-allowlist" &&
      opts.desired.preferredChildModel &&
      opts.desired.preferredChildModel !== currentSessionConfig.preferredChildModel
    ) {
      configPatch.preferredChildModel = opts.desired.preferredChildModel;
    }
    if (
      opts.desired.childModelRoutingMode &&
      opts.desired.childModelRoutingMode !== currentSessionConfig.childModelRoutingMode
    ) {
      configPatch.childModelRoutingMode = opts.desired.childModelRoutingMode;
    }
    if (
      opts.desired.preferredChildModelRef &&
      opts.desired.preferredChildModelRef !== currentSessionConfig.preferredChildModelRef
    ) {
      configPatch.preferredChildModelRef = opts.desired.preferredChildModelRef;
    }
    if (
      opts.desired.allowedChildModelRefs &&
      !stringArrayEqual(
        opts.desired.allowedChildModelRefs,
        currentSessionConfig.allowedChildModelRefs,
      )
    ) {
      configPatch.allowedChildModelRefs = opts.desired.allowedChildModelRefs;
    }

    const desiredProviderOptions = normalizeWorkspaceProviderOptions(opts.desired.providerOptions);
    const currentProviderOptions = normalizeWorkspaceProviderOptions(
      currentSessionConfig.providerOptions,
    );
    if (
      JSON.stringify(desiredProviderOptions ?? null) !==
        JSON.stringify(currentProviderOptions ?? null) &&
      desiredProviderOptions
    ) {
      configPatch.providerOptions =
        desiredProviderOptions as OpenAiCompatibleProviderOptionsByProvider;
    }

    if (
      opts.desired.userName !== undefined &&
      opts.desired.userName !== currentSessionConfig.userName
    ) {
      configPatch.userName = opts.desired.userName;
    }
    if (
      opts.desired.userProfile !== undefined &&
      !userProfileEqual(opts.desired.userProfile, currentSessionConfig.userProfile)
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
    const controlConfig = runtime?.controlConfig as
      | { provider?: unknown; model?: unknown }
      | null
      | undefined;
    const controlSessionConfig = runtime?.controlSessionConfig;
    const provider =
      workspace.defaultProvider && isProviderName(workspace.defaultProvider)
        ? workspace.defaultProvider
        : controlConfig?.provider && isProviderName(controlConfig.provider)
          ? controlConfig.provider
          : "google";
    const liveDefaultModel = get().providerDefaultModelByProvider[provider]?.trim() || "";
    const controlModel = typeof controlConfig?.model === "string" ? controlConfig.model.trim() : "";
    const defaultModel =
      workspace.defaultModel?.trim() ||
      controlModel ||
      liveDefaultModel ||
      defaultModelForProvider(provider);
    const defaultPreferredChildModel =
      controlSessionConfig?.preferredChildModel?.trim() ||
      workspace.defaultPreferredChildModel?.trim() ||
      defaultModel;
    const defaultPreferredChildModelRef =
      controlSessionConfig?.preferredChildModelRef?.trim() ||
      workspace.defaultPreferredChildModelRef?.trim() ||
      (defaultPreferredChildModel ? `${provider}:${defaultPreferredChildModel}` : undefined);

    const memoryDefaults = resolveWorkspaceMemoryDefaultsFromControl(
      workspace,
      controlSessionConfig,
    );

    return {
      ...workspace,
      defaultProvider: provider,
      defaultModel,
      defaultPreferredChildModel,
      defaultChildModelRoutingMode:
        controlSessionConfig?.childModelRoutingMode ??
        workspace.defaultChildModelRoutingMode ??
        "same-provider",
      defaultPreferredChildModelRef,
      defaultAllowedChildModelRefs:
        controlSessionConfig?.allowedChildModelRefs ?? workspace.defaultAllowedChildModelRefs ?? [],
      defaultToolOutputOverflowChars:
        controlSessionConfig?.defaultToolOutputOverflowChars ??
        workspace.defaultToolOutputOverflowChars,
      defaultAdvancedMemory: memoryDefaults.defaultAdvancedMemory,
      defaultMemoryGenerationModel: memoryDefaults.defaultMemoryGenerationModel,
      providerOptions: mergeWorkspaceProviderOptionsPreservingSearchSettings(
        workspace.providerOptions,
        normalizeWorkspaceProviderOptions(controlSessionConfig?.providerOptions),
      ),
      userName:
        typeof controlSessionConfig?.userName === "string"
          ? controlSessionConfig.userName
          : workspace.userName,
      userProfile: controlSessionConfig?.userProfile
        ? normalizeWorkspaceUserProfile(controlSessionConfig.userProfile)
        : workspace.userProfile
          ? normalizeWorkspaceUserProfile(workspace.userProfile)
          : undefined,
      defaultEnableMcp:
        typeof runtime?.controlEnableMcp === "boolean"
          ? runtime.controlEnableMcp
          : workspace.defaultEnableMcp,
      defaultBackupsEnabled:
        typeof controlSessionConfig?.defaultBackupsEnabled === "boolean"
          ? controlSessionConfig.defaultBackupsEnabled
          : workspace.defaultBackupsEnabled,
      yolo:
        typeof controlSessionConfig?.yolo === "boolean"
          ? controlSessionConfig.yolo
          : workspace.yolo,
    };
  };

  const resolveSharedSettingsSource = (preferredWorkspaceId: string): WorkspaceRecord | null => {
    const state = get();
    const preferred =
      state.workspaces.find((workspace) => workspace.id === preferredWorkspaceId) ?? null;
    if (preferred && !isOneOffChatWorkspace(preferred)) {
      return preferred;
    }

    const selected = state.selectedWorkspaceId
      ? (state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId) ?? null)
      : null;
    if (selected && !isOneOffChatWorkspace(selected)) {
      return selected;
    }

    return (
      state.workspaces.find((workspace) => !isOneOffChatWorkspace(workspace)) ??
      preferred ??
      selected ??
      state.workspaces[0] ??
      null
    );
  };

  const syncWorkspaceDefaultsToRuntime = async (
    workspaceId: string,
    opts: { ensureControl: boolean; notifyOnMissingControl?: boolean },
  ) => {
    const desiredWorkspace = get().workspaces.find((workspace) => workspace.id === workspaceId);
    if (!desiredWorkspace) return;

    if (opts.ensureControl) {
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
    }

    const controlReady = opts.ensureControl
      ? await waitForControlSession(get, set, workspaceId)
      : Boolean(get().workspaceRuntimeById[workspaceId]?.controlSessionId);
    set((state) => ({
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, ...desiredWorkspace } : workspace,
      ),
    }));
    const nextWorkspace = desiredWorkspace;
    const workspacePath = nextWorkspace.path;

    const provider =
      nextWorkspace.defaultProvider && isProviderName(nextWorkspace.defaultProvider)
        ? nextWorkspace.defaultProvider
        : "google";
    const liveDefaultModel = get().providerDefaultModelByProvider[provider]?.trim() || "";
    const model =
      nextWorkspace.defaultModel?.trim() || liveDefaultModel || defaultModelForProvider(provider);
    const preferredChildModel = nextWorkspace.defaultPreferredChildModel?.trim() || model || "";
    const childModelRoutingMode = nextWorkspace.defaultChildModelRoutingMode ?? "same-provider";
    const preferredChildModelRef =
      nextWorkspace.defaultPreferredChildModelRef?.trim() ||
      (preferredChildModel ? `${provider}:${preferredChildModel}` : "");
    const allowedChildModelRefs = nextWorkspace.defaultAllowedChildModelRefs ?? [];
    const providerOptions = nextWorkspace.providerOptions;
    const userName = nextWorkspace.userName;
    const memoryDefaults = resolveControlApplyMemoryDefaults(nextWorkspace);
    const userProfile = nextWorkspace.userProfile
      ? normalizeWorkspaceUserProfile(nextWorkspace.userProfile)
      : undefined;
    const currentWorkspaceRuntime = get().workspaceRuntimeById[workspaceId];
    const controlMessage =
      controlReady && currentWorkspaceRuntime?.controlSessionId
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
              advancedMemory: memoryDefaults.advancedMemory,
              memoryGenerationModel: memoryDefaults.memoryGenerationModel,
              toolOutputOverflowChars: nextWorkspace.defaultToolOutputOverflowChars,
              yolo: nextWorkspace.yolo,
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
      ? !controlMessage ||
        (await requestJsonRpcControlEvent(get, set, workspaceId, "cowork/session/defaults/apply", {
          cwd: workspacePath,
          ...(controlMessage.provider !== undefined ? { provider: controlMessage.provider } : {}),
          ...(controlMessage.model !== undefined ? { model: controlMessage.model } : {}),
          ...(controlMessage.enableMcp !== undefined
            ? { enableMcp: controlMessage.enableMcp }
            : {}),
          ...(controlMessage.config !== undefined ? { config: controlMessage.config } : {}),
        }))
      : false;

    if (persisted && controlMessage) {
      set((s) => {
        const workspaceRuntime = s.workspaceRuntimeById[workspaceId];
        const workingDirectory = workspacePath ?? workspaceRuntime.controlConfig?.workingDirectory;
        const nextControlConfig =
          controlMessage.provider !== undefined &&
          controlMessage.model !== undefined &&
          workingDirectory
            ? {
                ...(workspaceRuntime.controlConfig ?? {}),
                provider: controlMessage.provider,
                model: controlMessage.model,
                workingDirectory,
              }
            : workspaceRuntime.controlConfig;
        return {
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...workspaceRuntime,
              ...(nextControlConfig ? { controlConfig: nextControlConfig } : {}),
              ...(controlMessage.enableMcp !== undefined
                ? { controlEnableMcp: controlMessage.enableMcp }
                : {}),
            },
          },
        };
      });
    }

    if (!persisted && opts.notifyOnMissingControl) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Workspace settings partially applied",
          detail:
            "Control session is not fully connected yet. Reopen the workspace settings to retry.",
        }),
      }));
    }

    const threadIds = get()
      .threads.filter((thread) => thread.workspaceId === workspaceId)
      .map((thread) => thread.id);
    for (const threadId of threadIds) {
      void get().applyWorkspaceDefaultsToThread(threadId, "explicit");
    }
  };

  const hasPendingWorkspaceDefaultApply = (threadId: string): boolean =>
    Boolean(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId));

  const flushQueuedThreadMessageIfReady = (threadId: string): boolean => {
    if (hasPendingWorkspaceDefaultApply(threadId) || get().threadRuntimeById[threadId]?.busy) {
      return false;
    }

    const next = shiftPendingThreadMessage(threadId);
    if (next === undefined) {
      return false;
    }
    const queuedAttachments = shiftPendingThreadAttachments(threadId);
    const queuedReferences = shiftPendingThreadReferences(threadId);

    const accepted = sendUserMessageToThread(
      get,
      set,
      threadId,
      next,
      undefined,
      queuedAttachments,
      queuedReferences,
    );
    if (!accepted) {
      prependPendingThreadMessageWithAttachments(
        threadId,
        next,
        queuedAttachments,
        queuedReferences,
      );
    }
    return accepted;
  };

  return {
    applyWorkspaceDefaultsToThread: async (
      threadId: string,
      mode: "auto" | "auto-resume" | "explicit" = "explicit",
      draftModelSelection: DraftModelSelection | null = null,
      opts?: { allowBeforeHydration?: boolean },
    ) => {
      const thread = get().threads.find((t) => t.id === threadId);
      if (!thread) return;
      const ws =
        mode === "explicit"
          ? (get().workspaces.find((entry) => entry.id === thread.workspaceId) ?? null)
          : resolveWorkspaceDefaults(thread.workspaceId);
      if (!ws) return;
      const rt = get().threadRuntimeById[threadId];
      if (!rt?.sessionId) return;
      const workspaceRuntime = get().workspaceRuntimeById[thread.workspaceId];
      const pendingApply = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId) ?? null;
      if (pendingApply?.inFlight) {
        return;
      }
      const allowBeforeHydration =
        opts?.allowBeforeHydration === true || pendingApply?.allowBeforeHydration === true;
      const effectiveDraftModelSelection: DraftModelSelection | null =
        mode === "auto-resume"
          ? null
          : (draftModelSelection ?? pendingApply?.draftModelSelection ?? null);
      if (
        mode !== "explicit" &&
        !allowBeforeHydration &&
        (rt.sessionConfig == null || typeof rt.enableMcp !== "boolean")
      ) {
        RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, {
          mode,
          draftModelSelection: effectiveDraftModelSelection,
          ...(allowBeforeHydration ? { allowBeforeHydration: true } : {}),
          inFlight: false,
        });
        return;
      }
      const harnessBackupsDefault = workspaceRuntime?.controlSessionConfig?.defaultBackupsEnabled;
      const harnessToolOutputOverflowChars =
        workspaceRuntime?.controlSessionConfig?.defaultToolOutputOverflowChars;

      // Defer model / provider / other config changes when the session is
      // busy — changing the model mid-turn is not safe.
      if (rt.busy) {
        RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, {
          mode,
          draftModelSelection: effectiveDraftModelSelection,
          ...(allowBeforeHydration ? { allowBeforeHydration: true } : {}),
          inFlight: false,
        });
        return;
      }

      const preserveSessionModel = mode === "auto-resume";
      const runtimeConfig = rt.config as { provider?: unknown } | null | undefined;

      const inferredProvider =
        !preserveSessionModel && ws.defaultProvider && isProviderName(ws.defaultProvider)
          ? ws.defaultProvider
          : isProviderName(runtimeConfig?.provider)
            ? runtimeConfig.provider
            : "google";

      let provider = inferredProvider;
      const liveDefaultModel = get().providerDefaultModelByProvider[provider]?.trim() || "";
      let model =
        (preserveSessionModel
          ? rt.config?.model?.trim()
          : ws.defaultModel?.trim() || liveDefaultModel || rt.config?.model?.trim() || "") ||
        undefined;

      if (!preserveSessionModel && effectiveDraftModelSelection) {
        const p = effectiveDraftModelSelection.provider;
        const m = effectiveDraftModelSelection.model.trim();
        if (isProviderName(p) && m) {
          provider = p;
          model = m;
        }
      }
      const preferredChildModel =
        (preserveSessionModel
          ? rt.sessionConfig?.preferredChildModel?.trim() || rt.config?.model?.trim() || ""
          : ws.defaultPreferredChildModel?.trim() ||
            ws.defaultModel?.trim() ||
            rt.sessionConfig?.preferredChildModel?.trim() ||
            "") || undefined;
      const childModelRoutingMode = preserveSessionModel
        ? (rt.sessionConfig?.childModelRoutingMode ?? "same-provider")
        : (ws.defaultChildModelRoutingMode ??
          rt.sessionConfig?.childModelRoutingMode ??
          "same-provider");
      const preferredChildModelRef =
        (preserveSessionModel
          ? rt.sessionConfig?.preferredChildModelRef?.trim()
          : ws.defaultPreferredChildModelRef?.trim() ||
            rt.sessionConfig?.preferredChildModelRef?.trim()) ||
        (provider && preferredChildModel ? `${provider}:${preferredChildModel}` : undefined);
      const allowedChildModelRefs = preserveSessionModel
        ? (rt.sessionConfig?.allowedChildModelRefs ?? [])
        : (ws.defaultAllowedChildModelRefs ?? rt.sessionConfig?.allowedChildModelRefs ?? []);
      let providerOptions = ws.providerOptions;
      const draftReasoningEffort = effectiveDraftModelSelection?.reasoningEffort;
      if (
        draftReasoningEffort &&
        (provider === "openai" || provider === "codex-cli") &&
        isOpenAiReasoningEffortValue(draftReasoningEffort)
      ) {
        providerOptions = mergeWorkspaceProviderOptions(ws.providerOptions, {
          [provider]: {
            reasoningEffort: draftReasoningEffort,
          },
        });
      } else if (
        draftReasoningEffort &&
        provider === "google" &&
        isGoogleReasoningEffortValue(draftReasoningEffort)
      ) {
        providerOptions = mergeWorkspaceProviderOptions(ws.providerOptions, {
          google: googleProviderOptionsForReasoningEffort(draftReasoningEffort),
        });
      }
      const userName = ws.userName;
      const memoryDefaults = resolveThreadApplyMemoryDefaults(
        ws,
        workspaceRuntime?.controlSessionConfig,
      );
      const userProfile = ws.userProfile
        ? normalizeWorkspaceUserProfile(ws.userProfile)
        : undefined;
      const desiredEnableMcp =
        mode === "explicit"
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
          ...(typeof (mode === "explicit" ? ws.defaultBackupsEnabled : harnessBackupsDefault) ===
          "boolean"
            ? {
                backupsEnabled:
                  mode === "explicit" ? ws.defaultBackupsEnabled : harnessBackupsDefault,
              }
            : {}),
          yolo: ws.yolo,
          advancedMemory: memoryDefaults.advancedMemory,
          memoryGenerationModel: memoryDefaults.memoryGenerationModel,
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
      if (message?.type !== "apply_session_defaults") {
        RUNTIME.pendingWorkspaceDefaultApplyByThread.delete(threadId);
        flushQueuedThreadMessageIfReady(threadId);
        return;
      }

      RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, {
        mode,
        draftModelSelection: effectiveDraftModelSelection,
        ...(allowBeforeHydration ? { allowBeforeHydration: true } : {}),
        inFlight: true,
      });
      try {
        const result = await requestJsonRpc(
          get,
          set,
          thread.workspaceId,
          "cowork/session/defaults/apply",
          {
            threadId: rt.sessionId,
            cwd: ws.path,
            ...(message.provider !== undefined ? { provider: message.provider } : {}),
            ...(message.model !== undefined ? { model: message.model } : {}),
            ...(message.enableMcp !== undefined ? { enableMcp: message.enableMcp } : {}),
            ...(message.config !== undefined ? { config: message.config } : {}),
          },
        );
        const applied = applyThreadJsonRpcResponseState(threadId, rt.sessionId, result);
        if (!applied.ok) {
          throw new ThreadDefaultsApplyResponseError(
            applied.errorMessage ?? "Unable to apply workspace defaults to the active thread.",
          );
        }
        appendThreadTranscript(threadId, "client", message);
      } catch (error) {
        const detail =
          error instanceof ThreadDefaultsApplyResponseError && error.message.trim()
            ? error.message
            : "Unable to apply workspace defaults to the active thread.";
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title:
              detail === "Unable to apply workspace defaults to the active thread."
                ? "Not connected"
                : "Unable to apply workspace defaults",
            detail,
          }),
        }));
      } finally {
        const currentPending = RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId);
        if (currentPending?.inFlight) {
          RUNTIME.pendingWorkspaceDefaultApplyByThread.delete(threadId);
        }
        flushQueuedThreadMessageIfReady(threadId);
      }
    },

    updateWorkspaceDefaults: async (
      workspaceId,
      patch: WorkspaceDefaultsPatch,
      opts?: { scope?: "settings" | "target" },
    ) => {
      const sharedSettings = !get().perWorkspaceSettings && opts?.scope !== "target";
      const sourceWorkspace = sharedSettings
        ? resolveSharedSettingsSource(workspaceId)
        : (get().workspaces.find((workspace) => workspace.id === workspaceId) ?? null);
      if (!sourceWorkspace) {
        return;
      }
      const chatSettingsTarget = !sharedSettings && isOneOffChatWorkspace(sourceWorkspace);

      const optimisticWorkspace = resolveWorkspaceDefaults(sourceWorkspace.id) ?? sourceWorkspace;
      if (!optimisticWorkspace) {
        return;
      }

      const nextWorkspace = applyWorkspacePatch(optimisticWorkspace, patch);
      const globalMemoryPatch = buildGlobalMemoryDefaultsPatch(patch, nextWorkspace);
      const hasGlobalMemoryPatch = hasGlobalMemoryDefaultsPatch(globalMemoryPatch);

      set((s) => ({
        workspaces: s.workspaces.map((workspace) => {
          const patchedWorkspace = sharedSettings
            ? copyWorkspaceSettings(workspace, nextWorkspace)
            : chatSettingsTarget && isOneOffChatWorkspace(workspace)
              ? copyWorkspaceSettings(workspace, nextWorkspace)
              : workspace.id === sourceWorkspace.id
                ? nextWorkspace
                : workspace;
          return applyGlobalMemoryDefaults(patchedWorkspace, globalMemoryPatch);
        }),
      }));
      await persistNow(get);

      const {
        clearDefaultToolOutputOverflowChars,
        userProfile: userProfilePatch,
        ...workspacePatch
      } = patch;
      const shouldSyncCoreSettings =
        workspacePatch.defaultProvider !== undefined ||
        workspacePatch.defaultModel !== undefined ||
        workspacePatch.defaultPreferredChildModel !== undefined ||
        workspacePatch.defaultChildModelRoutingMode !== undefined ||
        workspacePatch.defaultPreferredChildModelRef !== undefined ||
        workspacePatch.defaultAllowedChildModelRefs !== undefined ||
        workspacePatch.defaultToolOutputOverflowChars !== undefined ||
        clearDefaultToolOutputOverflowChars === true ||
        workspacePatch.defaultAdvancedMemory !== undefined ||
        workspacePatch.defaultMemoryGenerationModel !== undefined ||
        workspacePatch.defaultEnableMcp !== undefined ||
        workspacePatch.defaultBackupsEnabled !== undefined ||
        workspacePatch.providerOptions !== undefined ||
        workspacePatch.userName !== undefined ||
        userProfilePatch !== undefined ||
        workspacePatch.yolo !== undefined;
      if (!shouldSyncCoreSettings) {
        return;
      }

      if (hasGlobalMemoryPatch && !sharedSettings) {
        const workspaceIds = get().workspaces.map((workspace) => workspace.id);
        await syncWorkspaceDefaultsToRuntime(sourceWorkspace.id, {
          ensureControl: true,
          notifyOnMissingControl: true,
        });
        await Promise.all(
          workspaceIds
            .filter((targetWorkspaceId) => targetWorkspaceId !== sourceWorkspace.id)
            .map((targetWorkspaceId) =>
              syncWorkspaceDefaultsToRuntime(targetWorkspaceId, {
                ensureControl: false,
                notifyOnMissingControl: false,
              }),
            ),
        );
        return;
      }

      if (chatSettingsTarget) {
        const workspaceIds = get()
          .workspaces.filter((workspace) => isOneOffChatWorkspace(workspace))
          .map((workspace) => workspace.id);
        await syncWorkspaceDefaultsToRuntime(sourceWorkspace.id, {
          ensureControl: true,
          notifyOnMissingControl: true,
        });
        await Promise.all(
          workspaceIds
            .filter((targetWorkspaceId) => targetWorkspaceId !== sourceWorkspace.id)
            .map((targetWorkspaceId) =>
              syncWorkspaceDefaultsToRuntime(targetWorkspaceId, {
                ensureControl: false,
                notifyOnMissingControl: false,
              }),
            ),
        );
        return;
      }

      if (!sharedSettings) {
        await syncWorkspaceDefaultsToRuntime(sourceWorkspace.id, {
          ensureControl: true,
          notifyOnMissingControl: true,
        });
        return;
      }

      const workspaceIds = get().workspaces.map((workspace) => workspace.id);
      await syncWorkspaceDefaultsToRuntime(sourceWorkspace.id, {
        ensureControl: true,
        notifyOnMissingControl: true,
      });
      await Promise.all(
        workspaceIds
          .filter((targetWorkspaceId) => targetWorkspaceId !== sourceWorkspace.id)
          .map((targetWorkspaceId) =>
            syncWorkspaceDefaultsToRuntime(targetWorkspaceId, {
              ensureControl: false,
              notifyOnMissingControl: false,
            }),
          ),
      );
    },
  };
}
