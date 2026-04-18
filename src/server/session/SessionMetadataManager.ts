import { getObservabilityHealth } from "../../observability/runtime";
import { normalizeChildRoutingConfig } from "../../models/childModelRouting";
import {
  mergeEditableOpenAiCompatibleProviderOptions,
  pickEditableOpenAiCompatibleProviderOptions,
} from "../../shared/openaiCompatibleOptions";
import {
  WORKSPACE_FEATURE_FLAG_IDS,
  resolveWorkspaceFeatureFlags,
  type WorkspaceFeatureFlagOverrides,
} from "../../shared/featureFlags";
import { effectiveToolOutputOverflowChars } from "../../shared/toolOutputOverflow";
import type { AgentConfig, HarnessContextPayload } from "../../types";
import type { SessionConfigPatch } from "../protocol";
import { DEFAULT_SESSION_TITLE, heuristicTitleFromQuery, type SessionTitleSource } from "../sessionTitleService";
import type { SessionContext } from "./SessionContext";

type PrepareConfigUpdateOptions = {
  baseConfig?: AgentConfig;
  baseYolo?: boolean;
  baseMaxSteps?: number;
};

type PreparedConfigUpdate = {
  nextConfig: AgentConfig;
  nextYolo: boolean;
  nextMaxSteps: number;
  persistPatch: import("./SessionContext").PersistedProjectConfigPatch;
  refreshedSystemPrompt: Awaited<ReturnType<SessionContext["deps"]["loadSystemPromptWithSkillsImpl"]>> | null;
  emitObservabilityStatus: boolean;
  syncBackups: boolean;
  changed: boolean;
};

function stringArrayEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every((value, index) => value === (right ?? [])[index]);
}

function userProfileEqual(
  left: NonNullable<AgentConfig["userProfile"]> | undefined,
  right: NonNullable<AgentConfig["userProfile"]> | undefined,
): boolean {
  return (
    (left?.instructions ?? "") === (right?.instructions ?? "")
    && (left?.work ?? "") === (right?.work ?? "")
    && (left?.details ?? "") === (right?.details ?? "")
  );
}

function workspaceFeatureFlagsEqual(
  left: WorkspaceFeatureFlagOverrides | undefined,
  right: WorkspaceFeatureFlagOverrides | undefined,
): boolean {
  const normalizedLeft = resolveWorkspaceFeatureFlags(left);
  const normalizedRight = resolveWorkspaceFeatureFlags(right);
  return WORKSPACE_FEATURE_FLAG_IDS.every((flagId) => normalizedLeft[flagId] === normalizedRight[flagId]);
}

export class SessionMetadataManager {
  constructor(private readonly context: SessionContext) {}

  private effectiveUserProfile(config = this.context.state.config) {
    const profile = config.userProfile;
    return {
      instructions: profile?.instructions ?? "",
      work: profile?.work ?? "",
      details: profile?.details ?? "",
    };
  }

  private buildNextConfig(
    patch: SessionConfigPatch,
    normalizedChildRouting: ReturnType<typeof normalizeChildRoutingConfig> | undefined,
    baseConfig: AgentConfig,
  ): AgentConfig {
    let nextConfig: AgentConfig = baseConfig;
    if (patch.observabilityEnabled !== undefined) {
      nextConfig = { ...nextConfig, observabilityEnabled: patch.observabilityEnabled };
    }
    if (patch.backupsEnabled !== undefined) {
      nextConfig = { ...nextConfig, backupsEnabled: patch.backupsEnabled };
    }
    if (patch.enableMemory !== undefined) {
      nextConfig = { ...nextConfig, enableMemory: patch.enableMemory };
    }
    if (patch.memoryRequireApproval !== undefined) {
      nextConfig = { ...nextConfig, memoryRequireApproval: patch.memoryRequireApproval };
    }
    if (normalizedChildRouting !== undefined) {
      nextConfig = {
        ...nextConfig,
        preferredChildModel: normalizedChildRouting.preferredChildModel,
        childModelRoutingMode: normalizedChildRouting.childModelRoutingMode,
        preferredChildModelRef: normalizedChildRouting.preferredChildModelRef,
        allowedChildModelRefs: normalizedChildRouting.allowedChildModelRefs,
      };
    }
    if (patch.toolOutputOverflowChars !== undefined) {
      nextConfig = {
        ...nextConfig,
        toolOutputOverflowChars: patch.toolOutputOverflowChars,
        projectConfigOverrides: {
          ...nextConfig.projectConfigOverrides,
          toolOutputOverflowChars: patch.toolOutputOverflowChars,
        },
      };
    }
    if (patch.clearToolOutputOverflowChars) {
      const { toolOutputOverflowChars: _ignored, ...remainingOverrides } =
        nextConfig.projectConfigOverrides ?? {};
      nextConfig = {
        ...nextConfig,
        toolOutputOverflowChars: effectiveToolOutputOverflowChars(
          nextConfig.inheritedToolOutputOverflowChars
        ),
        projectConfigOverrides: Object.keys(remainingOverrides).length > 0 ? remainingOverrides : undefined,
      };
    }
    if (patch.providerOptions !== undefined) {
      nextConfig = {
        ...nextConfig,
        providerOptions: mergeEditableOpenAiCompatibleProviderOptions(
          nextConfig.providerOptions,
          patch.providerOptions,
        ),
      };
    }
    if (patch.userName !== undefined) {
      nextConfig = {
        ...nextConfig,
        userName: patch.userName,
      };
    }
    if (patch.userProfile !== undefined) {
      nextConfig = {
        ...nextConfig,
        userProfile: {
          ...this.effectiveUserProfile(nextConfig),
          ...patch.userProfile,
        },
      };
    }
    if (patch.featureFlags?.workspace !== undefined || patch.enableA2ui !== undefined) {
      const nextWorkspaceFeatureFlags = resolveWorkspaceFeatureFlags({
        ...nextConfig.featureFlags?.workspace,
        ...patch.featureFlags?.workspace,
        ...(patch.enableA2ui !== undefined ? { a2ui: patch.enableA2ui } : {}),
      });
      nextConfig = {
        ...nextConfig,
        enableA2ui: nextWorkspaceFeatureFlags.a2ui,
        featureFlags: {
          ...nextConfig.featureFlags,
          workspace: nextWorkspaceFeatureFlags,
        },
      };
    }
    return nextConfig;
  }

  private buildPersistPatch(
    patch: SessionConfigPatch,
    normalizedChildRouting: ReturnType<typeof normalizeChildRoutingConfig> | undefined,
  ): import("./SessionContext").PersistedProjectConfigPatch {
    const persistPatch: import("./SessionContext").PersistedProjectConfigPatch = {};
    if (normalizedChildRouting !== undefined) {
      persistPatch.preferredChildModel = normalizedChildRouting.preferredChildModel;
      persistPatch.childModelRoutingMode = normalizedChildRouting.childModelRoutingMode;
      persistPatch.preferredChildModelRef = normalizedChildRouting.preferredChildModelRef;
      persistPatch.allowedChildModelRefs = normalizedChildRouting.allowedChildModelRefs;
    }
    if (patch.observabilityEnabled !== undefined) {
      persistPatch.observabilityEnabled = patch.observabilityEnabled;
    }
    if (patch.backupsEnabled !== undefined) {
      persistPatch.backupsEnabled = patch.backupsEnabled;
    }
    if (patch.enableMemory !== undefined) {
      persistPatch.enableMemory = patch.enableMemory;
    }
    if (patch.memoryRequireApproval !== undefined) {
      persistPatch.memoryRequireApproval = patch.memoryRequireApproval;
    }
    if (patch.toolOutputOverflowChars !== undefined) {
      persistPatch.toolOutputOverflowChars = patch.toolOutputOverflowChars;
    }
    if (patch.clearToolOutputOverflowChars) {
      persistPatch.clearToolOutputOverflowChars = true;
    }
    if (patch.providerOptions !== undefined) {
      persistPatch.providerOptions = patch.providerOptions;
    }
    if (patch.userName !== undefined) {
      persistPatch.userName = patch.userName;
    }
    if (patch.userProfile !== undefined) {
      persistPatch.userProfile = patch.userProfile;
    }
    if (patch.featureFlags?.workspace !== undefined || patch.enableA2ui !== undefined) {
      persistPatch.featureFlags = {
        workspace: {
          ...(patch.featureFlags?.workspace ?? {}),
          ...(patch.enableA2ui !== undefined ? { a2ui: patch.enableA2ui } : {}),
        },
      };
    }
    return persistPatch;
  }

  private configUpdateChanged(
    baseConfig: AgentConfig,
    nextConfig: AgentConfig,
    baseYolo: boolean,
    nextYolo: boolean,
    baseMaxSteps: number,
    nextMaxSteps: number,
  ): boolean {
    return (
      baseYolo !== nextYolo
      || baseMaxSteps !== nextMaxSteps
      || (baseConfig.observabilityEnabled ?? false) !== (nextConfig.observabilityEnabled ?? false)
      || (baseConfig.backupsEnabled ?? true) !== (nextConfig.backupsEnabled ?? true)
      || (baseConfig.enableA2ui ?? false) !== (nextConfig.enableA2ui ?? false)
      || (baseConfig.enableMemory ?? true) !== (nextConfig.enableMemory ?? true)
      || (baseConfig.memoryRequireApproval ?? false) !== (nextConfig.memoryRequireApproval ?? false)
      || baseConfig.preferredChildModel !== nextConfig.preferredChildModel
      || (baseConfig.childModelRoutingMode ?? "same-provider") !== (nextConfig.childModelRoutingMode ?? "same-provider")
      || (baseConfig.preferredChildModelRef ?? `${baseConfig.provider}:${baseConfig.preferredChildModel}`)
        !== (nextConfig.preferredChildModelRef ?? `${nextConfig.provider}:${nextConfig.preferredChildModel}`)
      || !stringArrayEqual(baseConfig.allowedChildModelRefs, nextConfig.allowedChildModelRefs)
      || !Object.is(baseConfig.toolOutputOverflowChars ?? null, nextConfig.toolOutputOverflowChars ?? null)
      || !Object.is(
        baseConfig.projectConfigOverrides?.toolOutputOverflowChars ?? null,
        nextConfig.projectConfigOverrides?.toolOutputOverflowChars ?? null,
      )
      || JSON.stringify(
        pickEditableOpenAiCompatibleProviderOptions(baseConfig.providerOptions),
      ) !== JSON.stringify(
        pickEditableOpenAiCompatibleProviderOptions(nextConfig.providerOptions),
      )
      || (baseConfig.userName ?? "") !== (nextConfig.userName ?? "")
      || !userProfileEqual(baseConfig.userProfile, nextConfig.userProfile)
      || !workspaceFeatureFlagsEqual(baseConfig.featureFlags?.workspace, nextConfig.featureFlags?.workspace)
    );
  }

  getPublicConfig() {
    return {
      provider: this.context.state.config.provider,
      model: this.context.state.config.model,
      workingDirectory: this.context.state.config.workingDirectory,
      ...(this.context.state.config.outputDirectory ? { outputDirectory: this.context.state.config.outputDirectory } : {}),
    };
  }

  emitConfigUpdated() {
    this.context.emit({
      type: "config_updated",
      sessionId: this.context.id,
      config: this.getPublicConfig(),
    });
  }

  getSessionConfigEvent(): Extract<import("../protocol").ServerEvent, { type: "session_config" }> {
    const providerOptions = pickEditableOpenAiCompatibleProviderOptions(this.context.state.config.providerOptions);
    const defaultBackupsEnabled = this.context.state.config.backupsEnabled ?? true;
    const backupsEnabled = this.context.state.backupsEnabledOverride ?? defaultBackupsEnabled;
    const defaultToolOutputOverflowChars = this.context.state.config.projectConfigOverrides?.toolOutputOverflowChars;
    const toolOutputOverflowChars = effectiveToolOutputOverflowChars(this.context.state.config.toolOutputOverflowChars);
    const workspaceFeatureFlags = resolveWorkspaceFeatureFlags(this.context.state.config.featureFlags?.workspace);
    return {
      type: "session_config",
      sessionId: this.context.id,
      config: {
        yolo: this.context.state.yolo,
        observabilityEnabled: this.context.state.config.observabilityEnabled ?? false,
        backupsEnabled,
        enableA2ui: workspaceFeatureFlags.a2ui,
        enableMemory: this.context.state.config.enableMemory ?? true,
        memoryRequireApproval: this.context.state.config.memoryRequireApproval ?? false,
        defaultBackupsEnabled,
        preferredChildModel: this.context.state.config.preferredChildModel,
        childModelRoutingMode: this.context.state.config.childModelRoutingMode ?? "same-provider",
        preferredChildModelRef:
          this.context.state.config.preferredChildModelRef
          ?? `${this.context.state.config.provider}:${this.context.state.config.preferredChildModel}`,
        allowedChildModelRefs: this.context.state.config.allowedChildModelRefs ?? [],
        maxSteps: this.context.state.maxSteps,
        toolOutputOverflowChars,
        ...(defaultToolOutputOverflowChars !== undefined ? { defaultToolOutputOverflowChars } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        userName: this.context.state.config.userName,
        userProfile: this.effectiveUserProfile(),
        featureFlags: {
          workspace: workspaceFeatureFlags,
        },
      },
    };
  }

  getSessionInfoEvent(): Extract<import("../protocol").ServerEvent, { type: "session_info" }> {
    return {
      type: "session_info",
      sessionId: this.context.id,
      ...this.context.state.sessionInfo,
    };
  }

  getObservabilityStatusEvent(): Extract<import("../protocol").ServerEvent, { type: "observability_status" }> {
    const observability = this.context.state.config.observability;
    const config = observability
      ? {
          provider: observability.provider,
          baseUrl: observability.baseUrl,
          otelEndpoint: observability.otelEndpoint,
          ...(observability.tracingEnvironment ? { tracingEnvironment: observability.tracingEnvironment } : {}),
          ...(observability.release ? { release: observability.release } : {}),
          hasPublicKey: !!observability.publicKey,
          hasSecretKey: !!observability.secretKey,
          configured: !!observability.publicKey && !!observability.secretKey,
        }
      : null;

    return {
      type: "observability_status",
      sessionId: this.context.id,
      enabled: this.context.state.config.observabilityEnabled ?? false,
      health: getObservabilityHealth(this.context.state.config),
      config,
    };
  }

  updateSessionInfo(
    patch: Partial<import("./SessionContext").SessionInfoState>,
    opts?: { queuePersistSessionSnapshot?: boolean },
  ) {
    const next = {
      ...this.context.state.sessionInfo,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const changed = Object.entries(patch).some(([key, value]) => {
      return !Object.is(
        this.context.state.sessionInfo[key as keyof typeof this.context.state.sessionInfo],
        value,
      );
    });

    if (!changed) return;

    this.context.state.sessionInfo = next;
    this.context.emit(this.getSessionInfoEvent());
    if (opts?.queuePersistSessionSnapshot !== false) {
      this.context.queuePersistSessionSnapshot("session_info.updated");
    }
  }

  maybeGenerateTitleFromQuery(query: string) {
    if (this.context.state.hasGeneratedTitle) return;
    if (this.context.state.sessionInfo.titleSource === "manual") {
      this.context.state.hasGeneratedTitle = true;
      return;
    }
    this.context.state.hasGeneratedTitle = true;

    const titleConfig: AgentConfig = { ...this.context.state.config };
    const prompt = query.trim();
    if (!prompt) return;
    const heuristicTitle = heuristicTitleFromQuery(prompt);
    if (this.context.state.sessionInfo.titleSource === "default" && heuristicTitle && heuristicTitle !== DEFAULT_SESSION_TITLE) {
      this.updateSessionInfo({
        title: heuristicTitle,
        titleSource: "heuristic",
        titleModel: null,
      });
    }

    void (async () => {
      const generated = await this.context.deps.generateSessionTitleImpl({
        config: titleConfig,
        query: prompt,
      });
      if (this.context.state.sessionInfo.titleSource === "manual") return;
      this.updateSessionInfo({
        title: generated.title,
        titleSource: generated.source,
        titleModel: generated.model,
      });
    })().catch((err) => {
      this.context.emitTelemetry("session.title.generate", "error", {
        sessionId: this.context.id,
        error: this.context.formatError(err),
      });
    });
  }

  setSessionTitle(title: string) {
    const trimmed = title.trim();
    if (!trimmed) {
      this.context.emitError("validation_failed", "session", "Title must be non-empty");
      return;
    }
    this.context.state.hasGeneratedTitle = true;
    this.updateSessionInfo({
      title: trimmed,
      titleSource: "manual",
      titleModel: null,
    });
  }

  async prepareConfigUpdate(
    patch: SessionConfigPatch,
    opts?: PrepareConfigUpdateOptions,
  ): Promise<PreparedConfigUpdate | null> {
    const baseConfig = opts?.baseConfig ?? this.context.state.config;
    const baseYolo = opts?.baseYolo ?? this.context.state.yolo;
    const baseMaxSteps = opts?.baseMaxSteps ?? this.context.state.maxSteps;
    if (patch.toolOutputOverflowChars !== undefined && patch.clearToolOutputOverflowChars) {
      this.context.emitError(
        "validation_failed",
        "session",
        "toolOutputOverflowChars cannot be combined with clearToolOutputOverflowChars"
      );
      return null;
    }

    let normalizedChildRouting:
      | ReturnType<typeof normalizeChildRoutingConfig>
      | undefined;
    if (
      patch.preferredChildModel !== undefined
      || patch.childModelRoutingMode !== undefined
      || patch.preferredChildModelRef !== undefined
      || patch.allowedChildModelRefs !== undefined
    ) {
      try {
        normalizedChildRouting = normalizeChildRoutingConfig({
          provider: baseConfig.provider,
          model: baseConfig.model,
          childModelRoutingMode: patch.childModelRoutingMode ?? baseConfig.childModelRoutingMode,
          preferredChildModel: patch.preferredChildModel ?? baseConfig.preferredChildModel,
          preferredChildModelRef:
            patch.preferredChildModelRef !== undefined
              ? patch.preferredChildModelRef
              : patch.preferredChildModel !== undefined
                ? undefined
                : baseConfig.preferredChildModelRef,
          allowedChildModelRefs: patch.allowedChildModelRefs ?? baseConfig.allowedChildModelRefs,
          source: "session config",
        });
      } catch (err) {
        this.context.emitError("validation_failed", "session", err instanceof Error ? err.message : String(err));
        return null;
      }
    }

    const defaultBackupsEnabled = baseConfig.backupsEnabled ?? true;
    const nextConfig = this.buildNextConfig(patch, normalizedChildRouting, baseConfig);
    const nextYolo = patch.yolo ?? baseYolo;
    const nextMaxSteps = patch.maxSteps ?? baseMaxSteps;
    const shouldSyncBackups =
      patch.backupsEnabled !== undefined
      && (
        this.context.state.backupsEnabledOverride !== null
        || defaultBackupsEnabled !== patch.backupsEnabled
      );
    const changed =
      this.configUpdateChanged(baseConfig, nextConfig, baseYolo, nextYolo, baseMaxSteps, nextMaxSteps)
      || shouldSyncBackups;
    const persistPatch = this.buildPersistPatch(patch, normalizedChildRouting);
    if (patch.backupsEnabled !== undefined && defaultBackupsEnabled === patch.backupsEnabled) {
      delete persistPatch.backupsEnabled;
    }
    if (!changed) {
      return {
        nextConfig,
        nextYolo,
        nextMaxSteps,
        persistPatch,
        refreshedSystemPrompt: null,
        emitObservabilityStatus: false,
        syncBackups: false,
        changed: false,
      };
    }

    let refreshedSystemPrompt: Awaited<ReturnType<SessionContext["deps"]["loadSystemPromptWithSkillsImpl"]>> | null = null;
    if (
      patch.userName !== undefined
      || patch.userProfile !== undefined
      || patch.enableA2ui !== undefined
      || patch.featureFlags?.workspace !== undefined
      || patch.enableMemory !== undefined
      || patch.providerOptions !== undefined
    ) {
      try {
        refreshedSystemPrompt = await this.context.deps.loadSystemPromptWithSkillsImpl(
          nextConfig,
        );
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to refresh system prompt: ${String(err)}`
        );
        return null;
      }
    }

    return {
      nextConfig,
      nextYolo,
      nextMaxSteps,
      persistPatch,
      refreshedSystemPrompt,
      emitObservabilityStatus: patch.observabilityEnabled !== undefined,
      syncBackups: shouldSyncBackups,
      changed: true,
    };
  }

  async applyPreparedConfigUpdate(
    prepared: PreparedConfigUpdate,
    opts?: { persistDefaults?: boolean; queuePersistSessionSnapshot?: boolean },
  ): Promise<unknown | null> {
    if (prepared.changed && opts?.persistDefaults !== false && Object.keys(prepared.persistPatch).length > 0 && this.context.deps.persistProjectConfigPatchImpl) {
      try {
        await this.context.deps.persistProjectConfigPatchImpl(prepared.persistPatch);
      } catch (err) {
        return err;
      }
    }

    if (!prepared.changed) {
      return null;
    }

    this.context.state.yolo = prepared.nextYolo;
    this.context.state.config = prepared.nextConfig;
    if (prepared.syncBackups) {
      this.context.state.backupsEnabledOverride = null;
    }
    this.context.state.maxSteps = prepared.nextMaxSteps;
    if (prepared.refreshedSystemPrompt) {
      this.context.state.system = prepared.refreshedSystemPrompt.prompt;
      this.context.state.discoveredSkills = prepared.refreshedSystemPrompt.discoveredSkills;
      this.context.state.systemPromptMetadataLoaded = true;
    }

    if (prepared.emitObservabilityStatus) {
      this.context.emit(this.getObservabilityStatusEvent());
    }
    this.context.emit(this.getSessionConfigEvent());
    if (prepared.syncBackups) {
      await this.context.syncSessionBackupAvailability();
    }
    if (opts?.queuePersistSessionSnapshot !== false) {
      this.context.queuePersistSessionSnapshot("session.config_updated");
    }

    return null;
  }

  async setConfig(patch: SessionConfigPatch) {
    const prepared = await this.prepareConfigUpdate(patch);
    if (!prepared) {
      return;
    }
    if (!prepared.changed) {
      this.context.emitTelemetry("session.defaults.noop", "ok", {
        sessionId: this.context.id,
        operation: "set_config",
      });
      return;
    }

    const persistError = await this.applyPreparedConfigUpdate(prepared);
    if (persistError) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to persist config defaults: ${String(persistError)}`
      );
    }
  }

  async setBackupsEnabledOverride(backupsEnabledOverride: boolean | null) {
    this.context.state.backupsEnabledOverride = backupsEnabledOverride;
    this.context.emit(this.getSessionConfigEvent());
    await this.context.syncSessionBackupAvailability();
    this.context.queuePersistSessionSnapshot("session.backups_enabled_override_updated");
  }

  getHarnessContext() {
    this.context.emit({
      type: "harness_context",
      sessionId: this.context.id,
      context: this.context.deps.harnessContextStore.get(this.context.id),
    });
  }

  setHarnessContext(context: HarnessContextPayload) {
    const next = this.context.deps.harnessContextStore.set(this.context.id, context);
    this.context.emit({ type: "harness_context", sessionId: this.context.id, context: next });
    this.context.emitTelemetry("harness.context.set", "ok", {
      sessionId: this.context.id,
      runId: context.runId,
      objectiveLength: context.objective.length,
    });
    this.context.queuePersistSessionSnapshot("session.harness_context");
  }
}
