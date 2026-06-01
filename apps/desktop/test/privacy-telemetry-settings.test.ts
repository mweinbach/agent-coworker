import { describe, expect, test } from "bun:test";

import {
  normalizePrivacyTelemetrySettings,
  type PersistedPrivacyTelemetrySettings,
} from "../src/app/types";

describe("privacy telemetry settings", () => {
  test("defaults all toggles to false", () => {
    expect(normalizePrivacyTelemetrySettings()).toEqual({
      crashReportsEnabled: false,
      productAnalyticsEnabled: false,
      aiTraceTelemetryEnabled: false,
      aiTracePayloadsEnabled: false,
      diagnosticsUploadEnabled: false,
      cloudSyncEnabled: false,
    });
  });

  test("treats malformed values as false", () => {
    const settings = normalizePrivacyTelemetrySettings({
      crashReportsEnabled: "true",
      productAnalyticsEnabled: 1,
      aiTraceTelemetryEnabled: null,
      aiTracePayloadsEnabled: true,
      diagnosticsUploadEnabled: {},
      cloudSyncEnabled: [],
    } as PersistedPrivacyTelemetrySettings);

    expect(settings).toEqual({
      crashReportsEnabled: false,
      productAnalyticsEnabled: false,
      aiTraceTelemetryEnabled: false,
      aiTracePayloadsEnabled: false,
      diagnosticsUploadEnabled: false,
      cloudSyncEnabled: false,
    });
  });

  test("forces AI trace payloads off unless AI trace diagnostics are enabled", () => {
    expect(
      normalizePrivacyTelemetrySettings({
        aiTraceTelemetryEnabled: false,
        aiTracePayloadsEnabled: true,
      }).aiTracePayloadsEnabled,
    ).toBe(false);

    expect(
      normalizePrivacyTelemetrySettings({
        aiTraceTelemetryEnabled: true,
        aiTracePayloadsEnabled: true,
      }).aiTracePayloadsEnabled,
    ).toBe(true);
  });
});
