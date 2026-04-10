import { useMemo } from "react";
import { useAppStore } from "../../app/store";
import { PluginCardGrid } from "./PluginCardGrid";
import { PluginDetailDialog } from "./PluginDetailDialog";
import { InstallPluginDialog } from "./InstallPluginDialog";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { RefreshCwIcon } from "lucide-react";

export function PluginsCatalogPage({
  workspaceId,
  managementScope = "workspace",
  searchQuery,
}: {
  workspaceId: string;
  managementScope?: "workspace" | "global";
  searchQuery: string;
}) {
  const wsRtById = useAppStore((s) => s.workspaceRuntimeById);
  const refreshPluginsCatalog = useAppStore((s) => s.refreshPluginsCatalog);
  const selectPlugin = useAppStore((s) => s.selectPlugin);

  const rt = wsRtById[workspaceId];
  const catalog = rt?.pluginsCatalog ?? null;
  const pluginsLoading = rt?.pluginsLoading ?? false;
  const pluginsError = rt?.pluginsError ?? null;
  const showLoadingState = pluginsLoading && catalog === null;

  const plugins = useMemo(() => {
    let items = [...(catalog?.plugins ?? [])];
    if (managementScope === "global") {
      items = items.filter((plugin) => plugin.scope === "user");
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      items = items.filter((plugin) =>
        plugin.name.toLowerCase().includes(query)
        || plugin.displayName.toLowerCase().includes(query)
        || plugin.description.toLowerCase().includes(query)
        || plugin.interface?.shortDescription?.toLowerCase().includes(query)
      );
    }
    return items.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [catalog, searchQuery, managementScope]);

  const enabledPlugins = useMemo(() => plugins.filter((plugin) => plugin.enabled), [plugins]);
  const disabledPlugins = useMemo(() => plugins.filter((plugin) => !plugin.enabled), [plugins]);

  const emptyLabel = managementScope === "global"
    ? "No Codex-style plugins were discovered in your global library."
    : "No Codex-style plugins were discovered for this workspace.";

  return (
    <div className="app-skills-view h-full min-h-0 overflow-y-auto px-6 py-4">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => void refreshPluginsCatalog()}
          >
            <RefreshCwIcon className="mr-1.5 h-4 w-4" />
            Refresh
          </Button>
          <InstallPluginDialog workspaceId={workspaceId} />
        </div>

        <div className="space-y-8">
          {enabledPlugins.length > 0 ? (
            <section>
              <h2 className="mb-4 text-lg font-semibold">Enabled</h2>
              <PluginCardGrid plugins={enabledPlugins} onSelect={(pluginId, scope) => void selectPlugin(pluginId, scope)} />
            </section>
          ) : null}

          {disabledPlugins.length > 0 ? (
            <section>
              <h2 className="mb-4 text-lg font-semibold text-muted-foreground">Disabled</h2>
              <PluginCardGrid plugins={disabledPlugins} onSelect={(pluginId, scope) => void selectPlugin(pluginId, scope)} />
            </section>
          ) : null}

          {showLoadingState ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/50 bg-muted/10 py-10 text-center">
              <div className="mb-1 text-base font-medium">Loading...</div>
              <div className="text-sm text-muted-foreground">Fetching plugins catalog.</div>
            </div>
          ) : null}

          {!showLoadingState && pluginsError ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-4 text-left">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="border-destructive/40 text-destructive">
                  Connection issue
                </Badge>
                <span className="text-sm text-destructive">{pluginsError}</span>
              </div>
              <Button size="sm" variant="outline" onClick={() => void refreshPluginsCatalog()}>
                Retry
              </Button>
            </div>
          ) : null}

          {!showLoadingState && !pluginsError && plugins.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/50 bg-muted/10 py-10 text-center">
              <div className="mb-1 text-base font-medium">No plugins found</div>
              <div className="text-sm text-muted-foreground">
                {searchQuery ? "Try adjusting your search query." : emptyLabel}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <PluginDetailDialog workspaceId={workspaceId} />
    </div>
  );
}
