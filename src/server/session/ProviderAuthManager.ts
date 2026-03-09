import type { getAiCoworkerPaths } from "../../connect";
import { prepareCodexBrowserOAuth, type CodexBrowserOAuthPending } from "../../providers/codex-oauth-flows";
import {
  type ConnectProviderHandler,
  authorizeProviderAuth,
  callbackProviderAuth as callbackProviderAuthMethod,
  logoutProviderAuth as logoutProviderAuthMethod,
  resolveProviderAuthMethod,
  setProviderApiKey as setProviderApiKeyMethod,
} from "../../providers/authRegistry";
import { supportsOpenAiContinuation } from "../../shared/openaiContinuation";
import { isProviderName } from "../../types";
import type { AgentConfig, ServerErrorCode, ServerErrorSource } from "../../types";
import type { ServerEvent } from "../protocol";

export class ProviderAuthManager {
  private pendingCodexBrowserAuth: CodexBrowserOAuthPending | null = null;

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

  private clearPendingCodexBrowserAuth(): void {
    this.pendingCodexBrowserAuth?.close();
    this.pendingCodexBrowserAuth = null;
  }

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
    const shouldClearProviderState =
      currentConfig.provider !== nextProvider || currentConfig.model !== modelId;

    this.opts.setConfig({
      ...currentConfig,
      provider: nextProvider,
      model: modelId,
      subAgentModel: nextSubAgentModel,
    });
    if (shouldClearProviderState) {
      this.opts.clearProviderState();
    }

    let persistError: unknown = null;
    if (this.opts.persistModelSelection) {
      try {
        await this.opts.persistModelSelection({
          provider: nextProvider,
          model: modelId,
          subAgentModel: nextSubAgentModel,
        });
      } catch (err) {
        persistError = err;
      }
    }

    this.opts.emitConfigUpdated();
    this.opts.updateSessionInfo({
      provider: nextProvider,
      model: modelId,
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
    if (providerRaw !== "codex-cli" || methodId !== "oauth_cli") {
      this.clearPendingCodexBrowserAuth();
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
    if (providerRaw === "codex-cli" && methodId === "oauth_cli") {
      try {
        this.clearPendingCodexBrowserAuth();
        this.pendingCodexBrowserAuth = await prepareCodexBrowserOAuth();
      } catch (err) {
        const message = this.opts.formatError(err);
        this.opts.emitError("provider_error", "provider", `Codex OAuth initialization failed: ${message}`);
        this.opts.emitTelemetry("provider.auth.authorize", "error", {
          sessionId: this.opts.sessionId,
          provider: providerRaw,
          methodId,
          error: message,
        });
        return;
      }
    }
    this.opts.emit({
      type: "provider_auth_challenge",
      sessionId: this.opts.sessionId,
      provider: providerRaw,
      methodId,
      challenge: this.pendingCodexBrowserAuth && providerRaw === "codex-cli" && methodId === "oauth_cli"
        ? {
            ...result.challenge,
            url: this.pendingCodexBrowserAuth.authUrl,
          }
        : result.challenge,
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
        codexBrowserAuthPending:
          providerRaw === "codex-cli" && methodId === "oauth_cli" ? this.pendingCodexBrowserAuth ?? undefined : undefined,
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
      if (providerRaw === "codex-cli" && methodId === "oauth_cli") {
        this.clearPendingCodexBrowserAuth();
      }
      this.opts.setConnecting(false);
    }
  }

  async logoutProviderAuth(providerRaw: AgentConfig["provider"]) {
    if (!this.opts.guardBusy()) return;
    if (!isProviderName(providerRaw)) {
      this.opts.emitError("validation_failed", "provider", `Unsupported provider: ${String(providerRaw)}`);
      return;
    }
    if (providerRaw === "codex-cli") {
      this.clearPendingCodexBrowserAuth();
    }

    this.opts.setConnecting(true);
    const startedAt = Date.now();
    try {
      const result = await logoutProviderAuthMethod({
        provider: providerRaw,
        paths: this.opts.getCoworkPaths(),
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
}
