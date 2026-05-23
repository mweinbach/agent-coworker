import {
  FEATURE_FLAG_DEFINITIONS,
  FEATURE_FLAG_IDS,
  type FeatureFlagId,
} from "../../../../../../src/shared/featureFlags";
import { useAppStore } from "../../../app/store";
import { Switch } from "../../../components/ui/switch";
import { SettingsPage, SettingsRow, SettingsSection } from "../SettingsPrimitives";

export function FeatureFlagsPage() {
  const updateState = useAppStore((s) => s.updateState);
  const desktopFeatureFlags = useAppStore((s) => s.desktopFeatureFlags);
  const setDesktopFeatureFlagOverride = useAppStore((s) => s.setDesktopFeatureFlagOverride);

  const toggleDesktopFlag = (flagId: FeatureFlagId, enabled: boolean) => {
    void setDesktopFeatureFlagOverride(flagId, enabled);
  };

  return (
    <SettingsPage>
      <SettingsSection
        title="Experimental capabilities"
        description="These flags are global across all workspaces. Some toggles require a restart to fully apply."
      >
        {FEATURE_FLAG_IDS.map((flagId) => {
          const definition = FEATURE_FLAG_DEFINITIONS[flagId];
          const forcedOffInPackaged =
            definition.packagedAvailability === "forced-off" && updateState.packaged;
          const enabled = desktopFeatureFlags[flagId] === true;
          return (
            <SettingsRow
              key={flagId}
              title={definition.label}
              description={definition.description}
              meta={
                forcedOffInPackaged
                  ? "Unavailable in packaged builds."
                  : definition.restartRequired
                    ? "Restart the app after changing this flag."
                    : undefined
              }
              control={
                <Switch
                  checked={enabled}
                  disabled={forcedOffInPackaged}
                  aria-label={definition.label}
                  onCheckedChange={(checked) => toggleDesktopFlag(flagId, checked)}
                />
              }
            ></SettingsRow>
          );
        })}
      </SettingsSection>
    </SettingsPage>
  );
}
