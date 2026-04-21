import { useAppStore } from "../../../app/store";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";
import {
  FEATURE_FLAG_DEFINITIONS,
  FEATURE_FLAG_IDS,
  type FeatureFlagId,
} from "../../../../../../src/shared/featureFlags";

export function FeatureFlagsPage() {
  const updateState = useAppStore((s) => s.updateState);
  const desktopFeatureFlags = useAppStore((s) => s.desktopFeatureFlags);
  const setDesktopFeatureFlagOverride = useAppStore((s) => s.setDesktopFeatureFlagOverride);

  const toggleDesktopFlag = (flagId: FeatureFlagId, enabled: boolean) => {
    void setDesktopFeatureFlagOverride(flagId, enabled);
  };

  return (
    <Card className="border-border/80 bg-card/85">
      <CardHeader>
        <CardTitle>Feature flags</CardTitle>
        <CardDescription>
          These flags are global across all workspaces. Some toggles require a restart to fully apply.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {FEATURE_FLAG_IDS.map((flagId) => {
          const definition = FEATURE_FLAG_DEFINITIONS[flagId];
          const forcedOffInPackaged = definition.packagedAvailability === "forced-off" && updateState.packaged;
          const enabled = desktopFeatureFlags[flagId] === true;
          return (
            <div key={flagId} className="flex items-start justify-between gap-4 max-[960px]:flex-col">
              <div>
                <div className="text-sm font-medium">{definition.label}</div>
                <div className="text-xs text-muted-foreground">{definition.description}</div>
                {forcedOffInPackaged ? (
                  <div className="mt-1 text-xs text-warning">
                    Unavailable in packaged builds.
                  </div>
                ) : null}
                {definition.restartRequired ? (
                  <div className="mt-1 text-xs text-muted-foreground">Restart the app after changing this flag.</div>
                ) : null}
              </div>
              <Switch
                checked={enabled}
                disabled={forcedOffInPackaged}
                aria-label={definition.label}
                onCheckedChange={(checked) => toggleDesktopFlag(flagId, checked)}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
