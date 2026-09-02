import type { PersistedPrivacyTelemetrySettings, PersistedState } from "../../src/app/types";

type DesktopStateEffects = {
  applyWindowSettings(state: PersistedState): void;
  applyProductAnalytics(state: PersistedState): Promise<unknown>;
  applyCrashReporting(settings?: PersistedPrivacyTelemetrySettings): Promise<unknown>;
};

/** Apply committed settings without starting another persistence transaction. */
export function createDesktopStateApplier(effects: DesktopStateEffects) {
  let crashReportingApplied = false;
  let crashReportsEnabled: boolean | undefined;

  return async (state: PersistedState): Promise<void> => {
    effects.applyWindowSettings(state);
    const nextCrashReportsEnabled = state.privacyTelemetrySettings?.crashReportsEnabled;
    const reporting =
      !crashReportingApplied || crashReportsEnabled !== nextCrashReportsEnabled
        ? effects.applyCrashReporting(state.privacyTelemetrySettings).then(() => {
            crashReportsEnabled = nextCrashReportsEnabled;
            crashReportingApplied = true;
          })
        : Promise.resolve();

    await Promise.all([effects.applyProductAnalytics(state), reporting]);
  };
}
