import type { getAiCoworkerPaths } from "../../connect";
import {
  type ConnectProviderHandler,
  authorizeProviderAuth,
  callbackProviderAuth as callbackProviderAuthMethod,
  resolveProviderAuthMethod,
  setProviderApiKey as setProviderApiKeyMethod,
} from "../../providers/authRegistry";
import { isProviderName } from "../../types";
import type { AgentConfig, ServerErrorCode, ServerErrorSource } from "../../types";
import type { ServerEvent } from "../protocol";

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
      persistModelSelection?: (selection: {
        provider: AgentConfig["provider"];
        model: string;
        subAgentModel: string;
      }) => Promise<void> | void;
      updateSessionInfo: (patch: Partial<{ provider: AgentConfig["provider"]; model: string }>) => void;
      queuePersistSessionSnapshot: (reason: string) => void;
      emitConfigUpdated: () => void;
      emitProviderCatalog: () => Promise<void>;
      refreshProviderStatus: () => Promise<void>;
      getCoworkPaths: () => ReturnType<typeof getAiCoworkerPaths>;
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
    const nextSubAgentModel = currentConfig.subAgentModel === currentConfig.model
      ? modelId
      : currentConfig.subAgentModel;

    if (this.opts.persistModelSelection) {
      try {
        await this.opts.persistModelSelection({
          provider: nextProvider,
          model: modelId,
          subAgentModel: nextSubAgentModel,
        });
      } catch (err) {
        this.opts.emitError("internal_error", "session", `Failed to persist model defaults: ${String(err)}`);
        return;
      }
    }

    this.opts.setConfig({
      ...currentConfig,
      provider: nextProvider,
      model: modelId,
      subAgentModel: nextSubAgentModel,
    });

    this.opts.emitConfigUpdated();
    this.opts.updateSessionInfo({
      provider: nextProvider,
      model: modelId,
    });

    this.opts.queuePersistSessionSnapshot("session.model_updated");
    await this.opts.emitProviderCatalog();
  }

  async authorizeProviderAuth(providerRaw: AgentConfig["provider"], methodIdRaw: string) {
    if (this.opts.isRunning()) {
      this.opts.emitError("busy", "session", "Agent is busy");
      return;
    }
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
        paths: this.opts.getCoworkPaths(),
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
          mode: result.mode ?? "unknown",
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
        paths: this.opts.getCoworkPaths(),
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
          mode: result.mode ?? "unknown",
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
}
