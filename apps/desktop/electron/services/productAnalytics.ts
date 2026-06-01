import { randomUUID } from "node:crypto";
import { app } from "electron";

import {
  captureProductEvent,
  initProductAnalytics,
  type ProductAnalyticsEventName,
  type ProductAnalyticsEventProperties,
  type ProductAnalyticsProperties,
  type ProductAnalyticsStatus,
  resolveProductAnalyticsConfig,
  setProductAnalyticsEnabled,
  shutdownProductAnalytics,
} from "../../../../src/telemetry/productAnalytics";
import {
  normalizeDesktopSettings,
  normalizePersistedProductAnalyticsState,
  normalizePrivacyTelemetrySettings,
  type PersistedPrivacyTelemetrySettings,
  type PersistedProductAnalyticsState,
  type PersistedState,
} from "../../src/app/types";
import type { DesktopProductAnalyticsConfig } from "../../src/lib/desktopApi";
import { writeLocalLog } from "./localLogs";

type DesktopProductAnalyticsServiceOptions = {
  env?: NodeJS.ProcessEnv;
  appVersion?: () => string;
  isPackaged?: () => boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  generateAnonymousId?: () => string;
};

type PreparedPersistedState = {
  state: PersistedState;
  changed: boolean;
};

function appVersion(): string {
  return app.getVersion().trim() || "unknown";
}

function generateAnonymousInstallationId(): string {
  return `anon_${randomUUID().replaceAll("-", "")}`;
}

function currentEnvironment(isPackaged: boolean, env: NodeJS.ProcessEnv): string {
  return (
    env.COWORK_POSTHOG_ENVIRONMENT?.trim() ||
    (env.NODE_ENV === "production" ? "production" : isPackaged ? "packaged" : "development")
  );
}

function hasProductAnalyticsConfigChanged(
  left: PersistedProductAnalyticsState | undefined,
  right: PersistedProductAnalyticsState | undefined,
): boolean {
  return (
    left?.anonymousInstallationId !== right?.anonymousInstallationId ||
    left?.lastAppVersion !== right?.lastAppVersion
  );
}

function buildInitContext(opts: {
  enabled: boolean;
  productAnalyticsState?: PersistedProductAnalyticsState;
  env: NodeJS.ProcessEnv;
  appVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  eventSource: "main" | "server";
}) {
  return {
    enabled: opts.enabled,
    env: opts.env,
    anonymousId: opts.productAnalyticsState?.anonymousInstallationId,
    release: opts.env.COWORK_RELEASE?.trim() || opts.appVersion,
    appVersion: opts.appVersion,
    environment: currentEnvironment(opts.isPackaged, opts.env),
    eventSource: opts.eventSource,
    platform: opts.platform,
    arch: opts.arch,
    packaged: opts.isPackaged,
  };
}

function resolveDesktopConfig(opts: {
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings | null;
  productAnalyticsState?: PersistedProductAnalyticsState | null;
  env: NodeJS.ProcessEnv;
  appVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  eventSource?: "main" | "server";
}) {
  const settings = normalizePrivacyTelemetrySettings(opts.privacyTelemetrySettings);
  return resolveProductAnalyticsConfig(
    buildInitContext({
      enabled: settings.productAnalyticsEnabled,
      productAnalyticsState: normalizePersistedProductAnalyticsState(opts.productAnalyticsState),
      env: opts.env,
      appVersion: opts.appVersion,
      isPackaged: opts.isPackaged,
      platform: opts.platform,
      arch: opts.arch,
      eventSource: opts.eventSource ?? "main",
    }),
  );
}

export function resolveDesktopProductAnalyticsConfig(
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings | null,
  productAnalyticsState?: PersistedProductAnalyticsState | null,
  env: NodeJS.ProcessEnv = process.env,
): DesktopProductAnalyticsConfig {
  const version = appVersion();
  const config = resolveDesktopConfig({
    privacyTelemetrySettings,
    productAnalyticsState,
    env,
    appVersion: version,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  });
  return {
    enabled: config.enabled,
    keyConfigured: config.keyConfigured,
    host: config.host,
    environment: config.environment,
    appVersion: version,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  };
}

export function applyProductAnalyticsProcessEnv(
  privacyTelemetrySettings?: PersistedPrivacyTelemetrySettings | null,
  productAnalyticsState?: PersistedProductAnalyticsState | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const version = appVersion();
  const config = resolveDesktopConfig({
    privacyTelemetrySettings,
    productAnalyticsState,
    env,
    appVersion: version,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  });
  env.COWORK_PRODUCT_ANALYTICS_ENABLED = config.enabled ? "true" : "false";
  env.COWORK_POSTHOG_HOST = config.host;
  env.COWORK_RELEASE = config.release ?? version;
  env.COWORK_POSTHOG_ENVIRONMENT = config.environment;
  env.COWORK_PLATFORM = process.platform;
  env.COWORK_ARCH = process.arch;
  if (config.anonymousId) {
    env.COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID = config.anonymousId;
  } else {
    delete env.COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID;
  }
}

export function buildDesktopProductAnalyticsEnv(
  privacyTelemetrySettings: PersistedPrivacyTelemetrySettings | null | undefined,
  productAnalyticsState: PersistedProductAnalyticsState | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const version = appVersion();
  const config = resolveDesktopConfig({
    privacyTelemetrySettings,
    productAnalyticsState,
    env,
    appVersion: version,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    eventSource: "server",
  });

  if (!config.enabled || !config.apiKey || !config.anonymousId) {
    return {
      COWORK_PRODUCT_ANALYTICS_ENABLED: "false",
    };
  }

  return {
    COWORK_PRODUCT_ANALYTICS_ENABLED: "true",
    COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID: config.anonymousId,
    COWORK_POSTHOG_KEY: config.apiKey,
    COWORK_POSTHOG_HOST: config.host,
    COWORK_RELEASE: config.release ?? version,
    COWORK_POSTHOG_ENVIRONMENT: config.environment,
    COWORK_PLATFORM: process.platform,
    COWORK_ARCH: process.arch,
  };
}

export class DesktopProductAnalyticsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolveAppVersion: () => string;
  private readonly resolveIsPackaged: () => boolean;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly generateAnonymousId: () => string;
  private persistedState: PersistedProductAnalyticsState | undefined;
  private pendingAppUpdated = false;
  private startupCaptured = false;
  private lastStatus: ProductAnalyticsStatus | null = null;

  constructor(options: DesktopProductAnalyticsServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.resolveAppVersion = options.appVersion ?? appVersion;
    this.resolveIsPackaged = options.isPackaged ?? (() => app.isPackaged);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.generateAnonymousId = options.generateAnonymousId ?? generateAnonymousInstallationId;
  }

  getStatus(): ProductAnalyticsStatus | null {
    return this.lastStatus;
  }

  getPersistedState(): PersistedProductAnalyticsState | undefined {
    return this.persistedState ? { ...this.persistedState } : undefined;
  }

  getRendererConfig(): DesktopProductAnalyticsConfig {
    const config = resolveDesktopConfig({
      privacyTelemetrySettings: undefined,
      productAnalyticsState: this.persistedState,
      env: this.env,
      appVersion: this.resolveAppVersion(),
      isPackaged: this.resolveIsPackaged(),
      platform: this.platform,
      arch: this.arch,
    });
    return {
      enabled: config.enabled,
      keyConfigured: config.keyConfigured,
      host: config.host,
      environment: config.environment,
      appVersion: this.resolveAppVersion(),
      platform: this.platform,
      arch: this.arch,
      packaged: this.resolveIsPackaged(),
    };
  }

  preparePersistedState(state: PersistedState): PreparedPersistedState {
    const settings = normalizePrivacyTelemetrySettings(state.privacyTelemetrySettings);
    const currentVersion = this.resolveAppVersion();
    const existing =
      normalizePersistedProductAnalyticsState(state.productAnalytics) ?? this.persistedState;
    let nextProductAnalytics = existing ? { ...existing } : undefined;

    const config = resolveDesktopConfig({
      privacyTelemetrySettings: state.privacyTelemetrySettings,
      productAnalyticsState: existing,
      env: this.env,
      appVersion: currentVersion,
      isPackaged: this.resolveIsPackaged(),
      platform: this.platform,
      arch: this.arch,
    });
    const shouldHaveIdentity = settings.productAnalyticsEnabled && config.keyConfigured;

    if (shouldHaveIdentity) {
      const anonymousInstallationId =
        existing?.anonymousInstallationId ?? this.generateAnonymousId();
      const lastAppVersion = existing?.lastAppVersion ?? null;
      if (lastAppVersion && lastAppVersion !== currentVersion) {
        this.pendingAppUpdated = true;
      }
      nextProductAnalytics = {
        anonymousInstallationId,
        lastAppVersion: currentVersion,
      };
    }

    const changed = hasProductAnalyticsConfigChanged(existing, nextProductAnalytics);
    this.persistedState = nextProductAnalytics;
    return {
      state: changed ? { ...state, productAnalytics: nextProductAnalytics } : state,
      changed,
    };
  }

  async applyPersistedState(state: PersistedState): Promise<PreparedPersistedState> {
    const prepared = this.preparePersistedState(state);
    const settings = normalizePrivacyTelemetrySettings(prepared.state.privacyTelemetrySettings);
    applyProductAnalyticsProcessEnv(
      prepared.state.privacyTelemetrySettings,
      prepared.state.productAnalytics,
      this.env,
    );

    this.lastStatus = await initProductAnalytics(
      buildInitContext({
        enabled: settings.productAnalyticsEnabled,
        productAnalyticsState: prepared.state.productAnalytics,
        env: this.env,
        appVersion: this.resolveAppVersion(),
        isPackaged: this.resolveIsPackaged(),
        platform: this.platform,
        arch: this.arch,
        eventSource: "main",
      }),
    );
    writeLocalLog("desktop-main.log", "info", "product-analytics", "product analytics status", {
      initialized: this.lastStatus.initialized,
      reason: this.lastStatus.reason,
      enabled: this.lastStatus.enabled,
      keyConfigured: this.lastStatus.keyConfigured,
    });

    if (this.lastStatus.initialized) {
      if (!this.startupCaptured) {
        this.startupCaptured = true;
        this.captureStartupEvent(prepared.state);
      }
      if (this.pendingAppUpdated) {
        this.pendingAppUpdated = false;
        captureProductEvent("app_updated", {
          eventSource: "main",
          status: "version_changed",
        });
      }
    } else if (!settings.productAnalyticsEnabled) {
      await setProductAnalyticsEnabled(false);
    }

    return prepared;
  }

  capture<Name extends ProductAnalyticsEventName>(
    name: Name,
    properties?: ProductAnalyticsEventProperties<Name>,
  ): void {
    captureProductEvent(name, properties ?? ({} as ProductAnalyticsEventProperties<Name>));
  }

  async shutdown(): Promise<void> {
    await shutdownProductAnalytics();
  }

  private captureStartupEvent(state: PersistedState): void {
    const settings = normalizePrivacyTelemetrySettings(state.privacyTelemetrySettings);
    const desktopSettings = normalizeDesktopSettings(state.desktopSettings);
    const providerCount = Object.values(state.providerState?.statusByName ?? {}).filter(
      (provider) => provider.authorized || provider.verified,
    ).length;
    const properties = {
      eventSource: "main",
      workspaceCount: state.workspaces.length,
      threadCount: state.threads.length,
      providerCount,
      productAnalyticsEnabled: settings.productAnalyticsEnabled,
      crashReportsEnabled: settings.crashReportsEnabled,
      aiTraceTelemetryEnabled: settings.aiTraceTelemetryEnabled,
      aiTracePayloadsEnabled: settings.aiTracePayloadsEnabled,
      diagnosticsUploadEnabled: settings.diagnosticsUploadEnabled,
      cloudSyncEnabled: settings.cloudSyncEnabled,
      quickChatIconEnabled: desktopSettings.quickChat.iconEnabled,
      quickChatShortcutEnabled: desktopSettings.quickChat.shortcutEnabled,
    } satisfies ProductAnalyticsProperties;
    captureProductEvent("app_started", properties);
  }
}
