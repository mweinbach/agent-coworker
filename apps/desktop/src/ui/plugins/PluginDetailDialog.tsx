import { ExternalLinkIcon, PackageIcon } from "lucide-react";
import { useMemo } from "react";

import { useAppStore } from "../../app/store";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { revealPath } from "../../lib/desktopCommands";
import { actionPending } from "../skills/utils";

function pluginScopeLabel(scope: "workspace" | "user"): string {
  return scope === "workspace" ? "Workspace" : "User";
}

function pluginDiscoveryLabel(kind: "marketplace" | "direct"): string {
  return kind === "marketplace" ? "Marketplace" : "Direct";
}

export function PluginDetailDialog({ workspaceId }: { workspaceId: string }) {
  const runtime = useAppStore((s) => s.workspaceRuntimeById[workspaceId]);
  const selectPlugin = useAppStore((s) => s.selectPlugin);
  const enablePlugin = useAppStore((s) => s.enablePlugin);
  const disablePlugin = useAppStore((s) => s.disablePlugin);

  const plugin = runtime?.selectedPlugin ?? null;
  const pluginId = runtime?.selectedPluginId ?? null;
  const pluginScope = runtime?.selectedPluginScope ?? null;

  const skillCount = plugin?.skills.length ?? 0;
  const mcpCount = plugin?.mcpServers.length ?? 0;
  const appCount = plugin?.apps.length ?? 0;

  const marketLabel = useMemo(() => {
    if (!plugin?.marketplace) return null;
    return plugin.marketplace.displayName ?? plugin.marketplace.name;
  }, [plugin]);
  const pluginError = runtime?.pluginsError ?? runtime?.skillMutationError ?? null;
  const enablePending = plugin
    ? actionPending(runtime, "plugin:enable", `${plugin.scope}:${plugin.id}`)
    : false;
  const disablePending = plugin
    ? actionPending(runtime, "plugin:disable", `${plugin.scope}:${plugin.id}`)
    : false;

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      void selectPlugin(null);
    }
  };

  if (!pluginId) return null;

  const isLoading =
    pluginId !== null && pluginScope !== null && plugin === null && pluginError === null;

  return (
    <Dialog open={pluginId !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto flex flex-col gap-0 p-0">
        {isLoading ? (
          <div className="flex items-center justify-center p-12 text-muted-foreground">
            Loading...
          </div>
        ) : plugin ? (
          <>
            <div className="border-b border-border/50 p-6 pb-4">
              <DialogHeader className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-muted/40 text-foreground">
                      <PackageIcon className="h-6 w-6" />
                    </div>
                    <div className="space-y-1">
                      <DialogTitle className="text-xl">{plugin.displayName}</DialogTitle>
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span>{pluginScopeLabel(plugin.scope)}</span>
                        <span>·</span>
                        <span>{pluginDiscoveryLabel(plugin.discoveryKind)}</span>
                        {marketLabel ? (
                          <>
                            <span>·</span>
                            <span>{marketLabel}</span>
                          </>
                        ) : null}
                        <Button
                          type="button"
                          variant="link"
                          className="h-auto p-0 text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            void revealPath({ path: plugin.rootDir });
                          }}
                        >
                          <span className="flex items-center gap-1">
                            Open folder <ExternalLinkIcon className="h-3 w-3" />
                          </span>
                        </Button>
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
              <div className="flex flex-wrap gap-2">
                <Badge variant={plugin.enabled ? "default" : "secondary"}>
                  {plugin.enabled ? "Enabled" : "Disabled"}
                </Badge>
                <Badge variant="secondary">{pluginScopeLabel(plugin.scope)}</Badge>
                <Badge variant="outline">{pluginDiscoveryLabel(plugin.discoveryKind)}</Badge>
                {plugin.version ? <Badge variant="outline">v{plugin.version}</Badge> : null}
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="rounded-lg border border-border/60 bg-muted/15 p-4">
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Skills
                  </div>
                  <div className="mt-2 text-2xl font-semibold">{skillCount}</div>
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/15 p-4">
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    MCP Servers
                  </div>
                  <div className="mt-2 text-2xl font-semibold">{mcpCount}</div>
                </div>
                <div className="rounded-lg border border-border/60 bg-muted/15 p-4">
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    Apps
                  </div>
                  <div className="mt-2 text-2xl font-semibold">{appCount}</div>
                </div>
              </div>

              {plugin.skills.length > 0 ? (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Bundled Skills</h3>
                  <div className="space-y-2">
                    {plugin.skills.map((skill) => (
                      <div
                        key={skill.name}
                        className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium">{skill.name}</div>
                            <div className="text-xs text-muted-foreground">{skill.description}</div>
                          </div>
                          <Badge variant={skill.enabled ? "default" : "secondary"}>
                            {skill.enabled ? "Enabled" : "Disabled"}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {plugin.mcpServers.length > 0 ? (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Bundled MCP Servers</h3>
                  <div className="flex flex-wrap gap-2">
                    {plugin.mcpServers.map((serverName) => (
                      <Badge key={serverName} variant="outline">
                        {serverName}
                      </Badge>
                    ))}
                  </div>
                </section>
              ) : null}

              {plugin.apps.length > 0 ? (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Bundled Apps</h3>
                  <div className="space-y-2">
                    {plugin.apps.map((app) => (
                      <div
                        key={app.id}
                        className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2"
                      >
                        <div className="text-sm font-medium">{app.displayName}</div>
                        <div className="text-xs text-muted-foreground">
                          {app.description ?? app.id}
                          {app.authType ? ` · auth: ${app.authType}` : ""}
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
                {plugin.enabled ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disablePending}
                    onClick={() => void disablePlugin(plugin.id, plugin.scope)}
                  >
                    {disablePending ? "Disabling..." : "Disable Plugin"}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={enablePending}
                    onClick={() => void enablePlugin(plugin.id, plugin.scope)}
                  >
                    {enablePending ? "Enabling..." : "Enable Plugin"}
                  </Button>
                )}
              </div>
              <Button size="sm" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
            <div className="text-base font-medium">Plugin unavailable</div>
            <div className="text-sm text-muted-foreground">
              {pluginError ?? "The selected plugin could not be loaded."}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
