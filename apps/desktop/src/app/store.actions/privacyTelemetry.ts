import { setProductAnalyticsEnabled as syncRendererProductAnalyticsPreference } from "../../lib/analytics";
import { syncRendererCrashReportingPreference } from "../../lib/crashReporting";
import {
  type AppStoreActions,
  persistNow,
  type StoreGet,
  type StoreSet,
  syncDesktopStateCacheNow,
} from "../store.helpers";
import { operationKey, runAcknowledgedOperation } from "../store.helpers/operations";
import {
  normalizePrivacyTelemetrySettings,
  type PersistedPrivacyTelemetrySettings,
  type PrivacyTelemetrySettings,
} from "../types";

type PrivacyTelemetryActionKeys =
  | "setCrashReportsEnabled"
  | "setProductAnalyticsEnabled"
  | "setAiTraceTelemetryEnabled"
  | "setAiTracePayloadsEnabled"
  | "setDiagnosticsUploadEnabled"
  | "setCloudSyncEnabled"
  | "setPrivacyTelemetrySettings";

type PrivacyTelemetryMutationOptions = {
  setting: string;
  label: string;
  errorTitle: string;
  patch: PersistedPrivacyTelemetrySettings;
  syncRuntime?: (settings: PrivacyTelemetrySettings) => Promise<void> | void;
};

function setPrivacyTelemetrySettingsState(set: StoreSet, settings: PrivacyTelemetrySettings) {
  set({ privacyTelemetrySettings: settings });
}

async function syncAllRendererTelemetryPreferences(
  settings: PrivacyTelemetrySettings,
): Promise<void> {
  syncRendererProductAnalyticsPreference(settings.productAnalyticsEnabled);
  await syncRendererCrashReportingPreference(settings.crashReportsEnabled);
}

export function createPrivacyTelemetryActions(
  set: StoreSet,
  get: StoreGet,
): Pick<AppStoreActions, PrivacyTelemetryActionKeys> {
  const updatePrivacyTelemetrySettings = async ({
    setting,
    label,
    errorTitle,
    patch,
    syncRuntime,
  }: PrivacyTelemetryMutationOptions) => {
    const previous = get().privacyTelemetrySettings;
    const next = normalizePrivacyTelemetrySettings({
      ...previous,
      ...patch,
    });

    return await runAcknowledgedOperation(get, set, {
      key: operationKey("privacy-telemetry", setting),
      label,
      errorTitle,
      errorMessage: "Unable to save the privacy preference.",
      repairAction: "Review the preference and retry.",
      optimistic: () => {
        setPrivacyTelemetrySettingsState(set, next);
        return () => {
          setPrivacyTelemetrySettingsState(set, previous);
          syncDesktopStateCacheNow(get);
          if (syncRuntime) {
            void Promise.resolve(syncRuntime(previous)).catch(() => {
              // The persisted preference and store state are authoritative on the next app start.
            });
          }
        };
      },
      execute: async () => {
        if (syncRuntime) {
          await syncRuntime(next);
        }
        await persistNow(get);
      },
    });
  };

  return {
    setCrashReportsEnabled: async (enabled) =>
      await updatePrivacyTelemetrySettings({
        setting: "crash-reports",
        label: "Update crash reports",
        errorTitle: "Crash reporting preference not saved",
        patch: { crashReportsEnabled: enabled },
        syncRuntime: async (settings) => {
          await syncRendererCrashReportingPreference(settings.crashReportsEnabled);
        },
      }),
    setProductAnalyticsEnabled: async (enabled) =>
      await updatePrivacyTelemetrySettings({
        setting: "product-analytics",
        label: "Update product analytics",
        errorTitle: "Analytics preference not saved",
        patch: { productAnalyticsEnabled: enabled },
        syncRuntime: (settings) => {
          syncRendererProductAnalyticsPreference(settings.productAnalyticsEnabled);
        },
      }),
    setAiTraceTelemetryEnabled: async (enabled) =>
      await updatePrivacyTelemetrySettings({
        setting: "ai-traces",
        label: "Update AI trace diagnostics",
        errorTitle: "AI trace preference not saved",
        patch: {
          aiTraceTelemetryEnabled: enabled,
          ...(enabled ? {} : { aiTracePayloadsEnabled: false }),
        },
      }),
    setAiTracePayloadsEnabled: async (enabled) =>
      await updatePrivacyTelemetrySettings({
        setting: "ai-trace-payloads",
        label: "Update full-payload AI traces",
        errorTitle: "Full-payload trace preference not saved",
        patch: { aiTracePayloadsEnabled: enabled },
      }),
    setDiagnosticsUploadEnabled: async (enabled) =>
      await updatePrivacyTelemetrySettings({
        setting: "diagnostics-upload",
        label: "Update diagnostics upload",
        errorTitle: "Diagnostics upload preference not saved",
        patch: { diagnosticsUploadEnabled: enabled },
      }),
    setCloudSyncEnabled: async (enabled) =>
      await updatePrivacyTelemetrySettings({
        setting: "cloud-sync",
        label: "Update cloud sync",
        errorTitle: "Cloud sync preference not saved",
        patch: { cloudSyncEnabled: enabled },
      }),
    setPrivacyTelemetrySettings: async (patch) =>
      await updatePrivacyTelemetrySettings({
        setting: "all",
        label: "Update privacy preferences",
        errorTitle: "Privacy preferences not saved",
        patch,
        syncRuntime: syncAllRendererTelemetryPreferences,
      }),
  };
}
