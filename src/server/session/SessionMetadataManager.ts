import { getObservabilityHealth } from "../../observability/runtime";
import { assertSupportedModel } from "../../models/registry";
import {
  mergeEditableOpenAiCompatibleProviderOptions,
  pickEditableOpenAiCompatibleProviderOptions,
} from "../../shared/openaiCompatibleOptions";
import { effectiveToolOutputOverflowChars } from "../../shared/toolOutputOverflow";
import type { AgentConfig, HarnessContextPayload } from "../../types";
import type { SessionConfigPatch } from "../protocol";
import { DEFAULT_SESSION_TITLE, heuristicTitleFromQuery, type SessionTitleSource } from "../sessionTitleService";
import type { SessionContext } from "./SessionContext";

export class SessionMetadataManager {
  constructor(private readonly context: SessionContext) {}

  private effectiveUserProfile() {
    const profile = this.context.state.config.userProfile;
    return {
      instructions: profile?.instructions ?? "",
      work: profile?.work ?? "",
      details: profile?.details ?? "",
    };
  }

  private promptRefreshConfig(patch: SessionConfigPatch): AgentConfig {
    return {
      ...this.context.state.config,
      ...(patch.userName !== undefined ? { userName: patch.userName } : {}),
      ...(patch.userProfile !== undefined
        ? {
            userProfile: {
              ...this.effectiveUserProfile(),
              ...patch.userProfile,
            },
          }
        : {}),
    };
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
    return {
      type: "session_config",
      sessionId: this.context.id,
      config: {
        yolo: this.context.state.yolo,
        observabilityEnabled: this.context.state.config.observabilityEnabled ?? false,
        backupsEnabled,
        defaultBackupsEnabled,
        subAgentModel: this.context.state.config.subAgentModel,
        maxSteps: this.context.state.maxSteps,
        toolOutputOverflowChars,
        ...(defaultToolOutputOverflowChars !== undefined ? { defaultToolOutputOverflowChars } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        userName: this.context.state.config.userName,
        userProfile: this.effectiveUserProfile(),
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
    patch: Partial<{
      title: string;
      titleSource: SessionTitleSource;
      titleModel: string | null;
      provider: AgentConfig["provider"];
      model: string;
    }>
  ) {
    const next = {
      ...this.context.state.sessionInfo,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const changed =
      next.title !== this.context.state.sessionInfo.title ||
      next.titleSource !== this.context.state.sessionInfo.titleSource ||
      next.titleModel !== this.context.state.sessionInfo.titleModel ||
      next.provider !== this.context.state.sessionInfo.provider ||
      next.model !== this.context.state.sessionInfo.model;

    if (!changed) return;

    this.context.state.sessionInfo = next;
    this.context.emit(this.getSessionInfoEvent());
    this.context.queuePersistSessionSnapshot("session_info.updated");
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

  async setConfig(patch: SessionConfigPatch) {
    if (patch.toolOutputOverflowChars !== undefined && patch.clearToolOutputOverflowChars) {
      this.context.emitError(
        "validation_failed",
        "session",
        "toolOutputOverflowChars cannot be combined with clearToolOutputOverflowChars"
      );
      return;
    }

    let normalizedSubAgentModel: string | undefined;
    if (patch.subAgentModel !== undefined) {
      try {
        normalizedSubAgentModel = assertSupportedModel(
          this.context.state.config.provider,
          patch.subAgentModel,
          "sub-agent model",
        ).id;
      } catch (err) {
        this.context.emitError("validation_failed", "session", err instanceof Error ? err.message : String(err));
        return;
      }
    }

    let refreshedSystemPrompt: Awaited<ReturnType<SessionContext["deps"]["loadSystemPromptWithSkillsImpl"]>> | null = null;
    if (patch.userName !== undefined || patch.userProfile !== undefined) {
      try {
        refreshedSystemPrompt = await this.context.deps.loadSystemPromptWithSkillsImpl(this.promptRefreshConfig(patch));
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to refresh system prompt: ${String(err)}`
        );
        return;
      }
    }

    const persistPatch: import("./SessionContext").PersistedProjectConfigPatch = {};
    if (normalizedSubAgentModel !== undefined) {
      persistPatch.subAgentModel = normalizedSubAgentModel;
    }
    if (patch.observabilityEnabled !== undefined) {
      persistPatch.observabilityEnabled = patch.observabilityEnabled;
    }
    if (patch.backupsEnabled !== undefined) {
      persistPatch.backupsEnabled = patch.backupsEnabled;
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
    if (Object.keys(persistPatch).length > 0 && this.context.deps.persistProjectConfigPatchImpl) {
      try {
        await this.context.deps.persistProjectConfigPatchImpl(persistPatch);
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to persist config defaults: ${String(err)}`
        );
        return;
      }
    }

    if (patch.yolo !== undefined) this.context.state.yolo = patch.yolo;
    if (patch.observabilityEnabled !== undefined) {
      this.context.state.config = { ...this.context.state.config, observabilityEnabled: patch.observabilityEnabled };
      this.context.emit(this.getObservabilityStatusEvent());
    }
    if (patch.backupsEnabled !== undefined) {
      this.context.state.backupsEnabledOverride = null;
      this.context.state.config = { ...this.context.state.config, backupsEnabled: patch.backupsEnabled };
    }
    if (normalizedSubAgentModel !== undefined) {
      this.context.state.config = { ...this.context.state.config, subAgentModel: normalizedSubAgentModel };
    }
    if (patch.toolOutputOverflowChars !== undefined) {
      this.context.state.config = {
        ...this.context.state.config,
        toolOutputOverflowChars: patch.toolOutputOverflowChars,
        projectConfigOverrides: {
          ...this.context.state.config.projectConfigOverrides,
          toolOutputOverflowChars: patch.toolOutputOverflowChars,
        },
      };
    }
    if (patch.clearToolOutputOverflowChars) {
      const { toolOutputOverflowChars: _ignored, ...remainingOverrides } =
        this.context.state.config.projectConfigOverrides ?? {};
      this.context.state.config = {
        ...this.context.state.config,
        toolOutputOverflowChars: effectiveToolOutputOverflowChars(
          this.context.state.config.inheritedToolOutputOverflowChars
        ),
        projectConfigOverrides: Object.keys(remainingOverrides).length > 0 ? remainingOverrides : undefined,
      };
    }
    if (patch.providerOptions !== undefined) {
      this.context.state.config = {
        ...this.context.state.config,
        providerOptions: mergeEditableOpenAiCompatibleProviderOptions(
          this.context.state.config.providerOptions,
          patch.providerOptions,
        ),
      };
    }
    if (patch.userName !== undefined) {
      this.context.state.config = {
        ...this.context.state.config,
        userName: patch.userName,
      };
    }
    if (patch.userProfile !== undefined) {
      this.context.state.config = {
        ...this.context.state.config,
        userProfile: {
          ...this.effectiveUserProfile(),
          ...patch.userProfile,
        },
      };
    }
    if (patch.maxSteps !== undefined) this.context.state.maxSteps = patch.maxSteps;
    if (refreshedSystemPrompt) {
      this.context.state.system = refreshedSystemPrompt.prompt;
      this.context.state.discoveredSkills = refreshedSystemPrompt.discoveredSkills;
    }

    this.context.emit(this.getSessionConfigEvent());
    if (patch.backupsEnabled !== undefined) {
      await this.context.syncSessionBackupAvailability();
    }
    this.context.queuePersistSessionSnapshot("session.config_updated");
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
