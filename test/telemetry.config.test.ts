import { describe, expect, test } from "bun:test";

import {
  isNetworkTelemetryGloballyDisabled,
  resolveCloudSyncConfig,
  resolveTelemetryConfig,
  resolveTelemetryConsent,
} from "../src/telemetry/config";

const configuredEnv = {
  COWORK_SENTRY_DSN: "https://public@sentry.example/1",
  COWORK_POSTHOG_KEY: "phc_public",
  COWORK_POSTHOG_HOST: "https://posthog.example",
  LANGFUSE_BASE_URL: "https://langfuse.example",
  LANGFUSE_PUBLIC_KEY: "pk_langfuse",
  LANGFUSE_SECRET_KEY: "sk_langfuse",
  COWORK_DIAGNOSTICS_UPLOAD_URL: "https://diagnostics.example/upload",
  COWORK_CLOUD_SYNC_ENDPOINT: "https://sync.example/v1",
};

describe("telemetry config resolver", () => {
  test("global kill switch disables all network telemetry and cloud sync", () => {
    const env = {
      ...configuredEnv,
      COWORK_DISABLE_NETWORK_TELEMETRY: "1",
      COWORK_CLOUD_SYNC_ENABLED: "true",
    };
    const consent = resolveTelemetryConsent({
      settings: {
        crashReportsEnabled: true,
        productAnalyticsEnabled: true,
        aiTraceTelemetryEnabled: true,
        aiTracePayloadsEnabled: true,
        diagnosticsUploadEnabled: true,
        cloudSyncEnabled: true,
      },
      env,
      isPackaged: true,
    });
    const config = resolveTelemetryConfig({
      consent,
      env,
      isPackaged: true,
      anonymousId: "anon_1234567890123456",
      includeSecrets: true,
      surface: "server",
    });
    const cloud = resolveCloudSyncConfig({
      persisted: { enabled: true, provider: "custom", endpoint: "https://sync.example/v1" },
      env,
      includeSecrets: true,
    });

    expect(isNetworkTelemetryGloballyDisabled(env)).toBe(true);
    expect(config.crashReports.enabled).toBe(false);
    expect(config.productAnalytics.enabled).toBe(false);
    expect(config.aiTraces.enabled).toBe(false);
    expect(config.diagnosticsUpload.enabled).toBe(false);
    expect(config.diagnosticsUpload.uploadUrl).toBeNull();
    expect(config.diagnosticsUpload.status).toBe("disabled");
    expect(cloud.enabled).toBe(false);
    expect(cloud.status).toBe("disabled");
    expect(cloud.provider).toBe("none");
  });

  test("packaged public builds default off even when public keys exist", () => {
    const consent = resolveTelemetryConsent({
      settings: undefined,
      env: configuredEnv,
      isPackaged: true,
      mode: "packaged-public",
    });
    const config = resolveTelemetryConfig({
      consent,
      env: configuredEnv,
      isPackaged: true,
      anonymousId: "anon_1234567890123456",
      surface: "electron-renderer",
    });

    expect(consent.crashReportsEnabled).toBe(false);
    expect(consent.productAnalyticsEnabled).toBe(false);
    expect(consent.aiTraceTelemetryEnabled).toBe(false);
    expect(config.crashReports.status).toBe("disabled");
    expect(config.productAnalytics.status).toBe("disabled");
    expect(config.aiTraces.status).toBe("disabled");
  });

  test("missing config stays a no-op when consent is enabled", () => {
    const consent = resolveTelemetryConsent({
      settings: {
        crashReportsEnabled: true,
        productAnalyticsEnabled: true,
        aiTraceTelemetryEnabled: true,
        diagnosticsUploadEnabled: true,
      },
      env: {},
      isPackaged: false,
    });
    const config = resolveTelemetryConfig({
      consent,
      env: {},
      isPackaged: false,
      anonymousId: "anon_1234567890123456",
      surface: "server",
    });

    expect(config.crashReports.status).toBe("not_configured");
    expect(config.productAnalytics.status).toBe("not_configured");
    expect(config.aiTraces.status).toBe("not_configured");
    expect(config.diagnosticsUpload.status).toBe("local_only");
    expect(config.crashReports.enabled).toBe(false);
    expect(config.productAnalytics.enabled).toBe(false);
    expect(config.aiTraces.enabled).toBe(false);
  });

  test("renderer-safe config omits the Langfuse secret", () => {
    const consent = resolveTelemetryConsent({
      settings: { aiTraceTelemetryEnabled: true },
      env: configuredEnv,
      isPackaged: false,
    });
    const rendererConfig = resolveTelemetryConfig({
      consent,
      env: configuredEnv,
      surface: "electron-renderer",
      includeSecrets: true,
    });
    const serverConfig = resolveTelemetryConfig({
      consent,
      env: configuredEnv,
      surface: "server",
      includeSecrets: true,
    });

    expect(rendererConfig.aiTraces.hasSecretKey).toBe(true);
    expect("secretKey" in rendererConfig.aiTraces).toBe(false);
    expect(serverConfig.aiTraces.secretKey).toBe("sk_langfuse");
  });

  test("AI trace runtime export still requires the Langfuse secret", () => {
    const consent = resolveTelemetryConsent({
      settings: { aiTraceTelemetryEnabled: true },
      env: {
        LANGFUSE_BASE_URL: "https://langfuse.example",
        LANGFUSE_PUBLIC_KEY: "pk_langfuse",
      },
      isPackaged: true,
      mode: "packaged-public",
    });
    const config = resolveTelemetryConfig({
      consent,
      env: {
        LANGFUSE_BASE_URL: "https://langfuse.example",
        LANGFUSE_PUBLIC_KEY: "pk_langfuse",
      },
      isPackaged: true,
      surface: "server",
    });

    expect(config.aiTraces.status).toBe("not_configured");
    expect(config.aiTraces.enabled).toBe(false);
    expect(config.aiTraces.hasSecretKey).toBe(false);
  });

  test("cloud sync ignores endpoint and token under the kill switch", () => {
    const cloud = resolveCloudSyncConfig({
      persisted: { enabled: true, provider: "custom", endpoint: "https://sync.example/v1" },
      env: {
        COWORK_DISABLE_NETWORK_TELEMETRY: "yes",
        COWORK_CLOUD_SYNC_ENDPOINT: "https://env-sync.example/v1",
        COWORK_CLOUD_SYNC_TOKEN: "secret-token",
      },
      includeSecrets: true,
    });

    expect(cloud.enabled).toBe(false);
    expect(cloud.status).toBe("disabled");
    expect(cloud.endpoint).toBeUndefined();
    expect(cloud.token).toBeUndefined();
  });
});
