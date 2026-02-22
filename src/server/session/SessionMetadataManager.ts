import { getObservabilityHealth } from "../../observability/runtime";
import type { AgentConfig, HarnessContextPayload } from "../../types";
import { DEFAULT_SESSION_TITLE, heuristicTitleFromQuery, type SessionTitleSource } from "../sessionTitleService";
import type { SessionContext } from "./SessionContext";

export class SessionMetadataManager {
  constructor(private readonly context: SessionContext) {}

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
    return {
      type: "session_config",
      sessionId: this.context.id,
      config: {
        yolo: this.context.state.yolo,
        observabilityEnabled: this.context.state.config.observabilityEnabled ?? false,
        subAgentModel: this.context.state.config.subAgentModel,
        maxSteps: this.context.state.maxSteps,
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

  setConfig(patch: {
    yolo?: boolean;
    observabilityEnabled?: boolean;
    subAgentModel?: string;
    maxSteps?: number;
  }) {
    if (patch.yolo !== undefined) this.context.state.yolo = patch.yolo;
    if (patch.observabilityEnabled !== undefined) {
      this.context.state.config = { ...this.context.state.config, observabilityEnabled: patch.observabilityEnabled };
      this.context.emit(this.getObservabilityStatusEvent());
    }
    if (patch.subAgentModel !== undefined) {
      this.context.state.config = { ...this.context.state.config, subAgentModel: patch.subAgentModel };
    }
    if (patch.maxSteps !== undefined) this.context.state.maxSteps = patch.maxSteps;

    this.context.emit(this.getSessionConfigEvent());
    this.context.queuePersistSessionSnapshot("session.config_updated");

    const persistPatch: import("./SessionContext").PersistedProjectConfigPatch = {};
    if (patch.subAgentModel !== undefined) {
      persistPatch.subAgentModel = patch.subAgentModel;
    }
    if (patch.observabilityEnabled !== undefined) {
      persistPatch.observabilityEnabled = patch.observabilityEnabled;
    }
    if (Object.keys(persistPatch).length > 0 && this.context.deps.persistProjectConfigPatchImpl) {
      void Promise.resolve(this.context.deps.persistProjectConfigPatchImpl(persistPatch)).catch((err) => {
        this.context.emitError(
          "internal_error",
          "session",
          `Config updated for this session, but persisting defaults failed: ${String(err)}`
        );
      });
    }
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
