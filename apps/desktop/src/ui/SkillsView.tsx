import { useAppStore } from "../app/store";
import { Button } from "../components/ui/button";
import { SkillsCatalogPage } from "./skills";
import { PluginsCatalogPage } from "./plugins/PluginsCatalogPage";

export function SkillsView() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const pluginManagementWorkspaceId = useAppStore((s) => s.pluginManagementWorkspaceId);
  const catalogWorkspaceId = pluginManagementWorkspaceId ?? selectedWorkspaceId;
  const managementScope = pluginManagementWorkspaceId ? "workspace" : "global";
  const pluginViewMode = useAppStore((s) => s.workspaceRuntimeById[catalogWorkspaceId ?? ""]?.pluginViewMode ?? "plugins");
  const setPluginViewMode = useAppStore((s) => s.setPluginViewMode);

  if (!catalogWorkspaceId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <h2 className="text-[1.75rem] font-semibold tracking-tight">Pick a workspace</h2>
        <p className="text-sm text-muted-foreground">
          Select a workspace to load global and workspace plugin catalogs.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/50 px-6 pt-5 pb-4">
        <div className="inline-flex rounded-lg border border-border/60 bg-muted/20 p-1">
          <Button
            size="sm"
            variant={pluginViewMode === "plugins" ? "secondary" : "ghost"}
            className="h-8 rounded-md px-3"
            onClick={() => void setPluginViewMode("plugins")}
          >
            Plugins
          </Button>
          <Button
            size="sm"
            variant={pluginViewMode === "skills" ? "secondary" : "ghost"}
            className="h-8 rounded-md px-3"
            onClick={() => void setPluginViewMode("skills")}
          >
            Skills
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {pluginViewMode === "plugins"
          ? <PluginsCatalogPage workspaceId={catalogWorkspaceId} managementScope={managementScope} />
          : <SkillsCatalogPage workspaceId={catalogWorkspaceId} managementScope={managementScope} />}
      </div>
    </div>
  );
}
