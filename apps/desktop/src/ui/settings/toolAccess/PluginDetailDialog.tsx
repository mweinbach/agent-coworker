import { ExternalLinkIcon } from "lucide-react";
import { useMemo } from "react";

import { useAppStore } from "../../../app/store";
import { operationKey } from "../../../app/store.helpers";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Switch } from "../../../components/ui/switch";
import { confirmAction, revealPath } from "../../../lib/desktopCommands";
import {
  isInstalledPluginCatalogEntry,
  type SkillInstallationEntry,
} from "../../../lib/wsProtocol";
import { OperationFeedback } from "../../OperationFeedback";
import { EntityIcon, SettingsStatTile } from "../SettingsPrimitives";
import { pluginIcon, pluginSkillDisplayName, skillIcon } from "./catalogShared";
import { actionPending } from "./skillUtils";

function pluginScopeLabel(scope: "workspace" | "user"): string {
  return scope === "workspace" ? "Workspace" : "Library";
}

function pluginDiscoveryLabel(kind: "marketplace" | "direct"): string {
  return kind === "marketplace" ? "Marketplace" : "Direct";
}

export function PluginDetailDialog({ workspaceId }: { workspaceId: string }) {
  const runtime = useAppStore((s) => s.workspaceRuntimeById[workspaceId]);
  const selectPlugin = useAppStore((s) => s.selectPlugin);
  const installPlugins = useAppStore((s) => s.installPlugins);
  const enablePlugin = useAppStore((s) => s.enablePlugin);
  const disablePlugin = useAppStore((s) => s.disablePlugin);
  const deletePlugin = useAppStore((s) => s.deletePlugin);
  const checkPluginUpdate = useAppStore((s) => s.checkPluginUpdate);
  const updatePlugin = useAppStore((s) => s.updatePlugin);
  const enableSkillInstallation = useAppStore((s) => s.enableSkillInstallation);
  const disableSkillInstallation = useAppStore((s) => s.disableSkillInstallation);
  const operationsByKey = useAppStore((s) => s.operationsByKey);

  const plugin = runtime?.selectedPlugin ?? null;
  const pluginId = runtime?.selectedPluginId ?? null;
  const pluginsLoading = runtime?.pluginsLoading ?? false;
  const skillsCatalog = runtime?.skillsCatalog ?? null;
  const skillPendingKeys = runtime?.skillMutationPendingKeys ?? {};

  const installedPlugin = plugin && isInstalledPluginCatalogEntry(plugin) ? plugin : null;
  const skillCount = installedPlugin?.skills.length ?? 0;
  const mcpCount = installedPlugin?.mcpServers.length ?? 0;
  const appCount = installedPlugin?.apps.length ?? 0;
  const statTiles = [
    { label: "Skills", value: skillCount },
    { label: "MCP Servers", value: mcpCount },
    { label: "Apps", value: appCount },
  ].filter((stat) => stat.value > 0);

  // The skills catalog is the toggle source of truth: plugin-owned skill
  // installations carry the plugin's namespaced skill name plus a `plugin`
  // owner with the plugin id and scope (see src/skills/catalog.ts).
  const skillInstallationsByName = useMemo(() => {
    const byName = new Map<string, SkillInstallationEntry>();
    if (!installedPlugin) return byName;
    for (const installation of skillsCatalog?.installations ?? []) {
      if (installation.plugin?.pluginId !== installedPlugin.id) continue;
      if (installation.plugin.scope !== installedPlugin.scope) continue;
      byName.set(installation.name, installation);
    }
    return byName;
  }, [installedPlugin, skillsCatalog]);

  const skillTogglePending = (installationId: string) =>
    skillPendingKeys[`enable:${installationId}`] === true ||
    skillPendingKeys[`disable:${installationId}`] === true;

  const marketLabel = useMemo(() => {
    if (!plugin?.marketplace) return null;
    return plugin.marketplace.displayName ?? plugin.marketplace.name;
  }, [plugin]);
  const pluginError = plugin
    ? (runtime?.pluginMutationError ?? null)
    : (runtime?.pluginsError ?? null);
  const enablePending = plugin
    ? actionPending(runtime, "plugin:enable", `${plugin.scope}:${plugin.id}`, "plugin")
    : false;
  const disablePending = plugin
    ? actionPending(runtime, "plugin:disable", `${plugin.scope}:${plugin.id}`, "plugin")
    : false;
  const deletePending = plugin
    ? actionPending(runtime, "plugin:delete", `${plugin.scope}:${plugin.id}`, "plugin")
    : false;
  const installPending = plugin
    ? actionPending(runtime, `plugin:install:${plugin.scope}`, undefined, "plugin")
    : false;
  const checkUpdatePending = installedPlugin
    ? actionPending(
        runtime,
        "plugin:checkUpdate",
        `${installedPlugin.scope}:${installedPlugin.id}`,
        "plugin",
      )
    : false;
  const updatePending = installedPlugin
    ? actionPending(
        runtime,
        "plugin:update",
        `${installedPlugin.scope}:${installedPlugin.id}`,
        "plugin",
      )
    : false;
  const selectedOperation = plugin
    ? [
        operationsByKey[operationKey("plugin", "install")],
        operationsByKey[operationKey("plugin", "enable", plugin.scope, plugin.id)],
        operationsByKey[operationKey("plugin", "disable", plugin.scope, plugin.id)],
        operationsByKey[operationKey("plugin", "delete", plugin.scope, plugin.id)],
        operationsByKey[operationKey("plugin", "update", plugin.scope, plugin.id)],
      ].find((operation) => operation?.status === "pending" || operation?.status === "error")
    : undefined;
  const operationPending = selectedOperation?.status === "pending";

  const handleOpenChange = (open: boolean) => {
    if (!open && !operationPending) {
      void selectPlugin(null);
    }
  };

  const handleInstallPlugin = async (sourceInput: string, targetScope: "workspace" | "user") => {
    try {
      await installPlugins(sourceInput, targetScope);
    } catch {
      // Control-session and mutation errors are surfaced via runtime state.
    }
  };

  const handleCheckPluginUpdate = async (pluginId: string, scope: "workspace" | "user") => {
    try {
      await checkPluginUpdate(pluginId, scope);
    } catch {
      // Control-session and mutation errors are surfaced via runtime state.
    }
  };

  const handleUpdatePlugin = async (pluginId: string, scope: "workspace" | "user") => {
    try {
      await updatePlugin(pluginId, scope);
    } catch {
      // Control-session and mutation errors are surfaced via runtime state.
    }
  };

  if (!pluginId) return null;

  const isLoading = pluginId !== null && plugin === null && pluginError === null && pluginsLoading;

  return (
    <Dialog open={pluginId !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto flex flex-col gap-0 p-0">
        {isLoading ? (
          <div className="flex items-center justify-center p-12 text-center">
            <DialogHeader>
              <DialogTitle>Loading plugin</DialogTitle>
              <DialogDescription>Fetching plugin details.</DialogDescription>
            </DialogHeader>
          </div>
        ) : plugin ? (
          <>
            <div className="border-b border-border/50 p-6 pb-4">
              <DialogHeader className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <EntityIcon src={pluginIcon(plugin)} name={plugin.displayName} size="lg" />
                    <div className="space-y-1">
                      <DialogTitle className="text-xl">{plugin.displayName}</DialogTitle>
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span>{pluginScopeLabel(plugin.scope)}</span>
                        <span>/</span>
                        <span>{pluginDiscoveryLabel(plugin.discoveryKind)}</span>
                        {marketLabel ? (
                          <>
                            <span>/</span>
                            <span>{marketLabel}</span>
                          </>
                        ) : null}
                        {installedPlugin ? (
                          <Button
                            type="button"
                            variant="link"
                            className="h-auto p-0 text-muted-foreground hover:text-foreground"
                            onClick={() => {
                              void revealPath({ path: installedPlugin.rootDir });
                            }}
                          >
                            <span className="flex items-center gap-1">
                              Open folder <ExternalLinkIcon className="h-3 w-3" />
                            </span>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
                <DialogDescription className="text-base text-foreground">
                  {plugin.interface?.longDescription || plugin.description}
                </DialogDescription>
              </DialogHeader>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto p-6">
              {pluginError ? (
                <div className="rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-3 text-sm text-destructive">
                  {pluginError}
                </div>
              ) : null}
              <OperationFeedback operation={selectedOperation} />
              <div className="flex flex-wrap gap-2">
                <Badge variant={installedPlugin?.enabled ? "default" : "secondary"}>
                  {installedPlugin
                    ? installedPlugin.enabled
                      ? "Enabled"
                      : "Disabled"
                    : "Available"}
                </Badge>
                <Badge variant="secondary">{pluginScopeLabel(plugin.scope)}</Badge>
                <Badge variant="outline">{pluginDiscoveryLabel(plugin.discoveryKind)}</Badge>
                {installedPlugin?.version ? (
                  <Badge variant="outline">v{installedPlugin.version}</Badge>
                ) : null}
                {installedPlugin?.updateAvailable ? (
                  <Badge variant="outline">Update available</Badge>
                ) : null}
              </div>

              {installedPlugin?.updateCheckReason ? (
                <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2 text-sm text-muted-foreground">
                  {installedPlugin.updateCheckReason}
                </div>
              ) : null}

              {installedPlugin && statTiles.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  {statTiles.map((stat) => (
                    <SettingsStatTile key={stat.label} label={stat.label} value={stat.value} />
                  ))}
                </div>
              ) : null}

              {installedPlugin && installedPlugin.skills.length > 0 ? (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Bundled Skills</h3>
                  <div className="divide-y divide-border/30 overflow-hidden rounded-lg border border-border/60 bg-card/85">
                    {installedPlugin.skills.map((skill) => {
                      const displayName = pluginSkillDisplayName(installedPlugin.id, skill);
                      const installation = skillInstallationsByName.get(skill.name) ?? null;
                      const operation = installation
                        ? ["enable", "disable"]
                            .map(
                              (action) =>
                                operationsByKey[
                                  operationKey("skill", action, installation.installationId)
                                ],
                            )
                            .find(
                              (candidate) =>
                                candidate?.status === "pending" || candidate?.status === "error",
                            )
                        : undefined;
                      const togglePending = installation
                        ? skillTogglePending(installation.installationId) ||
                          operation?.status === "pending"
                        : false;
                      return (
                        <div
                          key={skill.name}
                          className="flex flex-wrap items-center gap-3 px-4 py-3"
                        >
                          <EntityIcon src={skillIcon(skill)} name={displayName} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground">
                              {displayName}
                            </div>
                            <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                              {skill.interface?.shortDescription || skill.description}
                            </div>
                          </div>
                          <Switch
                            checked={installation?.enabled ?? skill.enabled}
                            disabled={installation === null || togglePending}
                            aria-label={`Enable ${displayName}`}
                            onCheckedChange={(enabled) => {
                              if (!installation) return;
                              if (enabled) {
                                void enableSkillInstallation(installation.installationId);
                              } else {
                                void disableSkillInstallation(installation.installationId);
                              }
                            }}
                          />
                          <OperationFeedback operation={operation} className="basis-full" />
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {installedPlugin && installedPlugin.mcpServers.length > 0 ? (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Bundled MCP Servers</h3>
                  <div className="flex flex-wrap gap-2">
                    {installedPlugin.mcpServers.map((serverName) => (
                      <Badge key={serverName} variant="outline">
                        {serverName}
                      </Badge>
                    ))}
                  </div>
                </section>
              ) : null}

              {installedPlugin && installedPlugin.apps.length > 0 ? (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Bundled Apps</h3>
                  <div className="space-y-2">
                    {installedPlugin.apps.map((app) => (
                      <div
                        key={app.id}
                        className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2"
                      >
                        <div className="text-sm font-medium">{app.displayName}</div>
                        <div className="text-xs text-muted-foreground">
                          {app.description ?? app.id}
                          {app.authType ? ` / auth: ${app.authType}` : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {plugin.warnings.length > 0 ? (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Warnings</h3>
                  <div className="rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-3 text-sm text-destructive">
                    {plugin.warnings.map((warning) => (
                      <div key={warning}>{warning}</div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>

            <div className="flex items-center justify-between border-t border-border/50 bg-muted/10 p-4">
              <div className="flex items-center gap-2">
                {!installedPlugin && plugin.installSource ? (
                  <Button
                    size="sm"
                    disabled={installPending}
                    onClick={() =>
                      void handleInstallPlugin(plugin.installSource ?? "", plugin.scope)
                    }
                  >
                    {installPending ? "Installing..." : "Install plugin"}
                  </Button>
                ) : installedPlugin?.enabled ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disablePending}
                    onClick={() => void disablePlugin(plugin.id, plugin.scope)}
                  >
                    {disablePending ? "Disabling..." : "Disable plugin"}
                  </Button>
                ) : installedPlugin ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={enablePending}
                    onClick={() => void enablePlugin(plugin.id, plugin.scope)}
                  >
                    {enablePending ? "Enabling..." : "Enable plugin"}
                  </Button>
                ) : null}
                {installedPlugin?.installSource ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={checkUpdatePending}
                    onClick={() => void handleCheckPluginUpdate(plugin.id, plugin.scope)}
                  >
                    {checkUpdatePending ? "Checking..." : "Check for updates"}
                  </Button>
                ) : null}
                {installedPlugin?.installSource && installedPlugin.updateAvailable ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={installPending || updatePending}
                    onClick={() => void handleUpdatePlugin(plugin.id, plugin.scope)}
                  >
                    {updatePending ? "Updating..." : "Update plugin"}
                  </Button>
                ) : null}
                {installedPlugin ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={deletePending}
                    onClick={async () => {
                      const confirmed = await confirmAction({
                        title: "Remove plugin",
                        message: `Remove ${plugin.displayName}? This removes the plugin and its bundled skills from this scope.`,
                        detail: plugin.id,
                        kind: "warning",
                        confirmLabel: "Remove plugin",
                        cancelLabel: "Cancel",
                        defaultAction: "cancel",
                      });
                      if (!confirmed) return;
                      void deletePlugin(plugin.id, plugin.scope);
                    }}
                  >
                    {deletePending ? "Removing..." : "Remove plugin"}
                  </Button>
                ) : null}
              </div>
              <Button size="sm" disabled={operationPending} onClick={() => handleOpenChange(false)}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
            <DialogHeader>
              <DialogTitle>Plugin unavailable</DialogTitle>
              <DialogDescription>
                {pluginError ?? "The selected plugin could not be loaded."}
              </DialogDescription>
            </DialogHeader>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
