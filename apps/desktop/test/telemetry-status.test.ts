import { describe, expect, test } from "bun:test";

import type { PersistedPrivacyTelemetrySettings } from "../../../src/telemetry/config";
import { resolveDesktopTelemetryStatus } from "../electron/services/telemetryStatus";
import type { PersistedState } from "../src/app/types";

function stateWithPrivacy(settings: PersistedPrivacyTelemetrySettings): PersistedState {
  return {
    version: 2,
    workspaces: [],
    threads: [],
    privacyTelemetrySettings: settings,
  };
}

describe("desktop telemetry status", () => {
  test("reports AI trace mode from current consent when public Langfuse config is present", () => {
    const env = {
      COWORK_TELEMETRY_MODE: "packaged-public",
      LANGFUSE_BASE_URL: "https://langfuse.example",
      LANGFUSE_PUBLIC_KEY: "pk_langfuse",
    };

    const metadataOnly = resolveDesktopTelemetryStatus({
      state: stateWithPrivacy({
        aiTraceTelemetryEnabled: true,
        aiTracePayloadsEnabled: false,
      }),
      env,
      isPackaged: true,
      appVersion: "1.2.3",
    });
    const fullPayload = resolveDesktopTelemetryStatus({
      state: stateWithPrivacy({
        aiTraceTelemetryEnabled: true,
        aiTracePayloadsEnabled: true,
      }),
      env,
      isPackaged: true,
      appVersion: "1.2.3",
    });

    expect(metadataOnly.aiTraces).toEqual({
      label: "Metadata only",
      status: "metadata_only",
      configured: true,
      enabled: true,
    });
    expect(fullPayload.aiTraces).toEqual({
      label: "Full payload",
      status: "full_payload",
      configured: true,
      enabled: true,
    });
  });

  test("keeps AI traces not configured when public Langfuse config is missing", () => {
    const status = resolveDesktopTelemetryStatus({
      state: stateWithPrivacy({
        aiTraceTelemetryEnabled: true,
        aiTracePayloadsEnabled: true,
      }),
      env: { COWORK_TELEMETRY_MODE: "packaged-public" },
      isPackaged: true,
      appVersion: "1.2.3",
    });

    expect(status.aiTraces).toEqual({
      label: "Not configured",
      status: "not_configured",
      configured: false,
      enabled: false,
    });
  });
});
