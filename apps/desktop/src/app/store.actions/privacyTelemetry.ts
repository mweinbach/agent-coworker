import { type AppStoreActions, persistNow, type StoreGet, type StoreSet } from "../store.helpers";
import {
  normalizePrivacyTelemetrySettings,
  type PersistedPrivacyTelemetrySettings,
} from "../types";

type PrivacyTelemetryActionKeys =
  | "setCrashReportsEnabled"
  | "setProductAnalyticsEnabled"
  | "setAiTraceTelemetryEnabled"
  | "setAiTracePayloadsEnabled"
  | "setDiagnosticsUploadEnabled"
  | "setCloudSyncEnabled"
  | "setPrivacyTelemetrySettings";

function applyPrivacyTelemetrySettings(
  set: StoreSet,
  get: StoreGet,
  patch: PersistedPrivacyTelemetrySettings,
) {
  set((state) => ({
    privacyTelemetrySettings: normalizePrivacyTelemetrySettings({
      ...state.privacyTelemetrySettings,
      ...patch,
    }),
  }));
  void persistNow(get);
}

export function createPrivacyTelemetryActions(
  set: StoreSet,
  get: StoreGet,
): Pick<AppStoreActions, PrivacyTelemetryActionKeys> {
  return {
    setCrashReportsEnabled: (enabled) => {
      applyPrivacyTelemetrySettings(set, get, { crashReportsEnabled: enabled });
    },
    setProductAnalyticsEnabled: (enabled) => {
      applyPrivacyTelemetrySettings(set, get, { productAnalyticsEnabled: enabled });
    },
    setAiTraceTelemetryEnabled: (enabled) => {
      applyPrivacyTelemetrySettings(set, get, {
        aiTraceTelemetryEnabled: enabled,
        ...(enabled ? {} : { aiTracePayloadsEnabled: false }),
      });
    },
    setAiTracePayloadsEnabled: (enabled) => {
      applyPrivacyTelemetrySettings(set, get, { aiTracePayloadsEnabled: enabled });
    },
    setDiagnosticsUploadEnabled: (enabled) => {
      applyPrivacyTelemetrySettings(set, get, { diagnosticsUploadEnabled: enabled });
    },
    setCloudSyncEnabled: (enabled) => {
      applyPrivacyTelemetrySettings(set, get, { cloudSyncEnabled: enabled });
    },
    setPrivacyTelemetrySettings: (patch) => {
      applyPrivacyTelemetrySettings(set, get, patch);
    },
  };
}
