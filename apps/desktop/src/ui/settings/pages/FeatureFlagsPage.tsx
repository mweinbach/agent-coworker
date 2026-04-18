import { useMemo } from "react";

import { useAppStore } from "../../../app/store";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import {
  DESKTOP_FEATURE_FLAG_DEFINITIONS,
  DESKTOP_FEATURE_FLAG_IDS,
  type DesktopFeatureFlagId,
} from "../../../lib/desktopFeatureFlags";
import {
  WORKSPACE_FEATURE_FLAG_DEFINITIONS,
  WORKSPACE_FEATURE_FLAG_IDS,
  resolveWorkspaceFeatureFlags,
  type WorkspaceFeatureFlagId,
} from "../../../../../../src/shared/featureFlags";

export function FeatureFlagsPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const updateState = useAppStore((s) => s.updateState);

  const desktopFeatureFlags = useAppStore((s) => s.desktopFeatureFlags);
  const setDesktopFeatureFlagOverride = useAppStore((s) => s.setDesktopFeatureFlagOverride);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const workspaceFeatureFlags = resolveWorkspaceFeatureFlags(activeWorkspace?.defaultFeatureFlags);

  const toggleDesktopFlag = (flagId: DesktopFeatureFlagId, enabled: boolean) => {
    void setDesktopFeatureFlagOverride(flagId, enabled);
  };

  const toggleWorkspaceFlag = (flagId: WorkspaceFeatureFlagId, enabled: boolean) => {
    if (!activeWorkspace) {
      return;
    }
    void updateWorkspaceDefaults(activeWorkspace.id, {
      defaultFeatureFlags: {
        [flagId]: enabled,
      },
    });
  };

  return (
    <div className="space-y-5">
      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Desktop feature flags</CardTitle>
          <CardDescription>
            These flags control desktop shell behavior. Some toggles require a restart to fully apply.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {DESKTOP_FEATURE_FLAG_IDS.map((flagId) => {
            const definition = DESKTOP_FEATURE_FLAG_DEFINITIONS[flagId];
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

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Workspace feature flags</CardTitle>
          <CardDescription>
            Workspace-scoped flags sync through the harness defaults pipeline and persist to project config.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!activeWorkspace ? (
            <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
              Add a workspace to configure workspace-scoped feature flags.
            </div>
          ) : (
            <>
              {workspaces.length > 1 ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Workspace</div>
                  <Select value={activeWorkspace.id} onValueChange={(value) => void selectWorkspace(value)}>
                    <SelectTrigger aria-label="Feature flags workspace">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {workspaces.map((workspace) => (
                        <SelectItem key={workspace.id} value={workspace.id}>
                          {workspace.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
                <div className="text-sm font-medium text-foreground">{activeWorkspace.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">{activeWorkspace.path}</div>
              </div>

              {WORKSPACE_FEATURE_FLAG_IDS.map((flagId) => {
                const definition = WORKSPACE_FEATURE_FLAG_DEFINITIONS[flagId];
                return (
                  <div key={flagId} className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                    <div>
                      <div className="text-sm font-medium">{definition.label}</div>
                      <div className="text-xs text-muted-foreground">{definition.description}</div>
                    </div>
                    <Switch
                      checked={workspaceFeatureFlags[flagId] === true}
                      aria-label={definition.label}
                      onCheckedChange={(checked) => toggleWorkspaceFlag(flagId, checked)}
                    />
                  </div>
                );
              })}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
