import type { getAiCoworkerPaths } from "../../connect";
import {
  type ConnectProviderHandler,
  authorizeProviderAuth,
  callbackProviderAuth as callbackProviderAuthMethod,
  copyProviderApiKey as copyProviderApiKeyMethod,
  logoutProviderAuth as logoutProviderAuthMethod,
  resolveProviderAuthMethod,
  setProviderApiKey as setProviderApiKeyMethod,
} from "../../providers/authRegistry";
import { getOpenCodeDisplayName, isOpenCodeProviderName, isOpenCodeSiblingPair } from "../../providers/opencodeShared";
import { supportsOpenAiContinuation } from "../../shared/openaiContinuation";
import { defaultRuntimeNameForProvider, isProviderName } from "../../types";
import type { AgentConfig, ServerErrorCode, ServerErrorSource } from "../../types";
import type { ServerEvent } from "../protocol";
import { resolveModelMetadata } from "../../models/metadata";
import { normalizeChildRoutingConfig } from "../../models/childModelRouting";

export class ProviderAuthManager {
  constructor(
    private readonly opts: {
      sessionId: string;
      getConfig: () => AgentConfig;
      setConfig: (next: AgentConfig) => void;
      isRunning: () => boolean;
      guardBusy: () => boolean;
      setConnecting: (connecting: boolean) => void;
      emit: (evt: ServerEvent) => void;
      emitError: (code: ServerErrorCode, source: ServerErrorSource, message: string) => void;
      emitTelemetry: (
        name: string,
        status: "ok" | "error",
        attributes?: Record<string, string | number | boolean>,
        durationMs?: number
      ) => void;
      formatError: (err: unknown) => string;
      log: (line: string) => void;
      clearProviderState: () => void;
      persistModelSelection?: (selection: {
        provider: AgentConfig["provider"];
        model: string;
        preferredChildModel: string;
        childModelRoutingMode?: AgentConfig["childModelRoutingMode"];
        preferredChildModelRef?: string;
        allowedChildModelRefs?: string[];
      }) => Promise<void> | void;
      updateSessionInfo: (patch: Partial<{ provider: AgentConfig["provider"]; model: string }>) => void;
      queuePersistSessionSnapshot: (reason: string) => void;
      emitConfigUpdated: () => void;
      emitProviderCatalog: () => Promise<void>;
      refreshProviderStatus: () => Promise<void>;
      getGlobalAuthPaths: () => ReturnType<typeof getAiCoworkerPaths>;
      runProviderConnect: ConnectProviderHandler;
    }
  ) {}

  async setModel(modelIdRaw: string, providerRaw?: AgentConfig["provider"]) {
    const modelId = modelIdRaw.trim();
    if (!modelId) {
      this.opts.emitError("validation_failed", "session", "Model id is required");
      return;
    }
    if (this.opts.isRunning()) {
      this.opts.emitError("busy", "session", "Agent is busy");
      return;
    }

    if (providerRaw !== undefined && !isProviderName(providerRaw)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported provider: ${String(providerRaw)}`);
      return;
    }

    const currentConfig = this.opts.getConfig();
    const nextProvider = providerRaw ?? currentConfig.provider;
    let resolvedModel;
    try {
      resolvedModel = await resolveModelMetadata(nextProvider, modelId, {
        providerOptions: currentConfig.providerOptions,
        source: "model",
      });
    } catch (error) {
      this.opts.emitError("validation_failed", "provider", error instanceof Error ? error.message : String(error));
      return;
    }
    const normalizedChildRouting = normalizeChildRoutingConfig({
      provider: nextProvider,
      model: resolvedModel.id,
      childModelRoutingMode: currentConfig.childModelRoutingMode,
      preferredChildModelRef:
        currentConfig.provider !== nextProvider || currentConfig.preferredChildModel === currentConfig.model
          ? `${nextProvider}:${resolvedModel.id}`
          : currentConfig.preferredChildModelRef ?? currentConfig.preferredChildModel,
      allowedChildModelRefs: currentConfig.allowedChildModelRefs,
      source: "model selection",
    });
    const nextRuntime = currentConfig.provider === nextProvider
      ? currentConfig.runtime
      : defaultRuntimeNameForProvider(nextProvider);
    const shouldClearProviderState =
      currentConfig.provider !== nextProvider || currentConfig.model !== resolvedModel.id;

    this.opts.setConfig({
      ...currentConfig,
      provider: nextProvider,
      ...(nextRuntime !== undefined ? { runtime: nextRuntime } : {}),
      model: resolvedModel.id,
      preferredChildModel: normalizedChildRouting.preferredChildModel,
      childModelRoutingMode: normalizedChildRouting.childModelRoutingMode,
      preferredChildModelRef: normalizedChildRouting.preferredChildModelRef,
      allowedChildModelRefs: normalizedChildRouting.allowedChildModelRefs,
      knowledgeCutoff: resolvedModel.knowledgeCutoff,
    });
    if (shouldClearProviderState) {
      this.opts.clearProviderState();
    }

    let persistError: unknown = null;
    if (this.opts.persistModelSelection) {
      try {
        await this.opts.persistModelSelection({
          provider: nextProvider,
          model: resolvedModel.id,
          preferredChildModel: normalizedChildRouting.preferredChildModel,
          childModelRoutingMode: normalizedChildRouting.childModelRoutingMode,
          preferredChildModelRef: normalizedChildRouting.preferredChildModelRef,
          allowedChildModelRefs: normalizedChildRouting.allowedChildModelRefs,
        });
      } catch (err) {
        persistError = err;
      }
    }

    this.opts.emitConfigUpdated();
    this.opts.updateSessionInfo({
      provider: nextProvider,
      model: resolvedModel.id,
    });

    this.opts.queuePersistSessionSnapshot("session.model_updated");
    await this.opts.emitProviderCatalog();

    if (persistError) {
      this.opts.emitError(
        "internal_error",
        "session",
        `Model updated for this session, but failed to persist defaults: ${String(persistError)}`,
      );
    }
  }

  async authorizeProviderAuth(providerRaw: AgentConfig["provider"], methodIdRaw: string) {
    if (!this.opts.guardBusy()) return;
    if (!isProviderName(providerRaw)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported provider: ${String(providerRaw)}`);
      return;
    }
    const methodId = methodIdRaw.trim();
    if (!methodId) {
      this.opts.emitError("validation_failed", "provider", "Auth method id is required");
      return;
    }
    if (!resolveProviderAuthMethod(providerRaw, methodId)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported auth method "${methodId}" for ${providerRaw}.`);
      return;
    }

    const result = authorizeProviderAuth({ provider: providerRaw, methodId });
    if (!result.ok) {
      this.opts.emitError("provider_error", "provider", result.message);
      this.opts.emitTelemetry("provider.auth.authorize", "error", {
        sessionId: this.opts.sessionId,
        provider: providerRaw,
        methodId,
        error: result.message,
      });
      return;
    }
    this.opts.emit({
      type: "provider_auth_challenge",
      sessionId: this.opts.sessionId,
      provider: providerRaw,
      methodId,
      challenge: result.challenge,
    });
    this.opts.emitTelemetry("provider.auth.authorize", "ok", {
      sessionId: this.opts.sessionId,
      provider: providerRaw,
      methodId,
    });
  }

  async callbackProviderAuth(providerRaw: AgentConfig["provider"], methodIdRaw: string, codeRaw?: string) {
    if (!this.opts.guardBusy()) return;
    if (!isProviderName(providerRaw)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported provider: ${String(providerRaw)}`);
      return;
    }
    const methodId = methodIdRaw.trim();
    if (!methodId) {
      this.opts.emitError("validation_failed", "provider", "Auth method id is required");
      return;
    }
    if (!resolveProviderAuthMethod(providerRaw, methodId)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported auth method "${methodId}" for ${providerRaw}.`);
      return;
    }

    this.opts.setConnecting(true);
    const startedAt = Date.now();
    try {
      const code = codeRaw?.trim() ? codeRaw.trim() : undefined;
      const config = this.opts.getConfig();
      const result = await callbackProviderAuthMethod({
        provider: providerRaw,
        methodId,
        code,
        cwd: config.workingDirectory,
        paths: this.opts.getGlobalAuthPaths(),
        connect: async (opts) => await this.opts.runProviderConnect(opts),
        oauthStdioMode: "pipe",
        onOauthLine: (line) => this.opts.log(`[connect ${providerRaw}] ${line}`),
      });

      this.opts.emit({
        type: "provider_auth_result",
        sessionId: this.opts.sessionId,
        provider: providerRaw,
        methodId,
        ok: result.ok,
        mode: result.ok ? result.mode : undefined,
        message: result.message,
      });

      if (result.ok) {
        if (supportsOpenAiContinuation(providerRaw)) {
          this.opts.clearProviderState();
        }
        this.opts.queuePersistSessionSnapshot("provider.auth.callback");
        await this.opts.refreshProviderStatus();
        await this.opts.emitProviderCatalog();
      }
      this.opts.emitTelemetry(
        "provider.auth.callback",
        result.ok ? "ok" : "error",
        {
          sessionId: this.opts.sessionId,
          provider: providerRaw,
          methodId,
          mode: result.ok ? result.mode : "unknown",
        },
        Date.now() - startedAt
      );
    } catch (err) {
      this.opts.emitError("provider_error", "provider", `Provider auth callback failed: ${String(err)}`);
      this.opts.emitTelemetry(
        "provider.auth.callback",
        "error",
        {
          sessionId: this.opts.sessionId,
          provider: providerRaw,
          methodId,
          error: this.opts.formatError(err),
        },
        Date.now() - startedAt
      );
    } finally {
      this.opts.setConnecting(false);
    }
  }

  async logoutProviderAuth(providerRaw: AgentConfig["provider"]) {
    if (!this.opts.guardBusy()) return;
    if (!isProviderName(providerRaw)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported provider: ${String(providerRaw)}`);
      return;
    }

    this.opts.setConnecting(true);
    const startedAt = Date.now();
    try {
      const result = await logoutProviderAuthMethod({
        provider: providerRaw,
        paths: this.opts.getGlobalAuthPaths(),
      });

      this.opts.emit({
        type: "provider_auth_result",
        sessionId: this.opts.sessionId,
        provider: providerRaw,
        methodId: "logout",
        ok: result.ok,
        message: result.message,
      });

      if (result.ok) {
        if (supportsOpenAiContinuation(providerRaw)) {
          this.opts.clearProviderState();
        }
        this.opts.queuePersistSessionSnapshot("provider.auth.logout");
        await this.opts.refreshProviderStatus();
        await this.opts.emitProviderCatalog();
      }

      this.opts.emitTelemetry(
        "provider.auth.logout",
        result.ok ? "ok" : "error",
        {
          sessionId: this.opts.sessionId,
          provider: providerRaw,
        },
        Date.now() - startedAt,
      );
    } catch (err) {
      this.opts.emitError("provider_error", "provider", `Provider logout failed: ${String(err)}`);
      this.opts.emitTelemetry(
        "provider.auth.logout",
        "error",
        {
          sessionId: this.opts.sessionId,
          provider: providerRaw,
          error: this.opts.formatError(err),
        },
        Date.now() - startedAt,
      );
    } finally {
      this.opts.setConnecting(false);
    }
  }

  async setProviderApiKey(providerRaw: AgentConfig["provider"], methodIdRaw: string, apiKeyRaw: string) {
    if (!this.opts.guardBusy()) return;
    if (!isProviderName(providerRaw)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported provider: ${String(providerRaw)}`);
      return;
    }
    const methodId = methodIdRaw.trim();
    if (!methodId) {
      this.opts.emitError("validation_failed", "provider", "Auth method id is required");
      return;
    }
    if (!resolveProviderAuthMethod(providerRaw, methodId)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported auth method "${methodId}" for ${providerRaw}.`);
      return;
    }

    this.opts.setConnecting(true);
    const startedAt = Date.now();
    try {
      const config = this.opts.getConfig();
      const result = await setProviderApiKeyMethod({
        provider: providerRaw,
        methodId,
        apiKey: apiKeyRaw,
        cwd: config.workingDirectory,
        paths: this.opts.getGlobalAuthPaths(),
        connect: async (opts) => await this.opts.runProviderConnect(opts),
      });

      this.opts.emit({
        type: "provider_auth_result",
        sessionId: this.opts.sessionId,
        provider: providerRaw,
        methodId,
        ok: result.ok,
        mode: result.ok ? result.mode : undefined,
        message: result.message,
      });

      if (result.ok) {
        if (supportsOpenAiContinuation(providerRaw)) {
          this.opts.clearProviderState();
        }
        this.opts.queuePersistSessionSnapshot("provider.auth.api_key");
        await this.opts.refreshProviderStatus();
        await this.opts.emitProviderCatalog();
      }
      this.opts.emitTelemetry(
        "provider.auth.api_key",
        result.ok ? "ok" : "error",
        {
          sessionId: this.opts.sessionId,
          provider: providerRaw,
          methodId,
          mode: result.ok ? result.mode : "unknown",
        },
        Date.now() - startedAt
      );
    } catch (err) {
      this.opts.emitError("provider_error", "provider", `Setting provider API key failed: ${String(err)}`);
      this.opts.emitTelemetry(
        "provider.auth.api_key",
        "error",
        {
          sessionId: this.opts.sessionId,
          provider: providerRaw,
          methodId,
          error: this.opts.formatError(err),
        },
        Date.now() - startedAt
      );
    } finally {
      this.opts.setConnecting(false);
    }
  }

  async copyProviderApiKey(providerRaw: AgentConfig["provider"], sourceProviderRaw: AgentConfig["provider"]) {
    if (!this.opts.guardBusy()) return;
    if (!isProviderName(providerRaw)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported provider: ${String(providerRaw)}`);
      return;
    }
    if (!isProviderName(sourceProviderRaw)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported source provider: ${String(sourceProviderRaw)}`);
      return;
    }
    if (!isOpenCodeSiblingPair(providerRaw, sourceProviderRaw)) {
      this.opts.emitError(
        "validation_failed",
        "provider",
        "provider_auth_copy_api_key only supports copying between OpenCode Go and OpenCode Zen.",
      );
      return;
    }
    if (!isOpenCodeProviderName(sourceProviderRaw)) {
      this.opts.emitError(
        "validation_failed",
        "provider",
        "provider_auth_copy_api_key sourceProvider must be an OpenCode provider.",
      );
      return;
    }

    const methodId = "api_key";
    if (!resolveProviderAuthMethod(providerRaw, methodId)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported auth method "${methodId}" for ${providerRaw}.`);
      return;
    }

    this.opts.setConnecting(true);
    const startedAt = Date.now();
    try {
      const config = this.opts.getConfig();
      const result = await copyProviderApiKeyMethod({
        provider: providerRaw,
        sourceProvider: sourceProviderRaw,
        methodId,
        cwd: config.workingDirectory,
        paths: this.opts.getGlobalAuthPaths(),
        connect: async (opts) => await this.opts.runProviderConnect(opts),
      });

      this.opts.emit({
        type: "provider_auth_result",
        sessionId: this.opts.sessionId,
        provider: providerRaw,
        methodId,
        ok: result.ok,
        mode: result.ok ? result.mode : undefined,
        message: result.ok
          ? `Copied ${getOpenCodeDisplayName(sourceProviderRaw)} API key. ${result.message}`
          : result.message,
      });

      if (result.ok) {
        if (supportsOpenAiContinuation(providerRaw)) {
          this.opts.clearProviderState();
        }
        this.opts.queuePersistSessionSnapshot("provider.auth.api_key_copy");
        await this.opts.refreshProviderStatus();
        await this.opts.emitProviderCatalog();
      }
      this.opts.emitTelemetry(
        "provider.auth.api_key_copy",
        result.ok ? "ok" : "error",
        {
          sessionId: this.opts.sessionId,
          provider: providerRaw,
          sourceProvider: sourceProviderRaw,
          methodId,
          mode: result.ok ? result.mode : "unknown",
        },
        Date.now() - startedAt,
      );
    } catch (err) {
      this.opts.emitError("provider_error", "provider", `Copying provider API key failed: ${String(err)}`);
      this.opts.emitTelemetry(
        "provider.auth.api_key_copy",
        "error",
        {
          sessionId: this.opts.sessionId,
          provider: providerRaw,
          sourceProvider: sourceProviderRaw,
          methodId,
          error: this.opts.formatError(err),
        },
        Date.now() - startedAt,
      );
    } finally {
      this.opts.setConnecting(false);
    }
  }
}
