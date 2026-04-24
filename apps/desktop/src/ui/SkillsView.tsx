import { SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { resolvePluginCatalogWorkspaceSelection } from "../app/pluginManagement";
import { useAppStore } from "../app/store";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { PluginsCatalogPage } from "./plugins/PluginsCatalogPage";
import { SkillsCatalogPage } from "./skills";

export function SkillsView() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const pluginManagementWorkspaceId = useAppStore((s) => s.pluginManagementWorkspaceId);
  const pluginManagementMode = useAppStore((s) => s.pluginManagementMode);
  const selection = resolvePluginCatalogWorkspaceSelection({
    workspaces,
    selectedWorkspaceId,
    pluginManagementWorkspaceId,
    pluginManagementMode,
  });
  const catalogWorkspaceId = selection.catalogWorkspaceId;
  const managementScope = selection.managementScope;
  const pluginViewMode = useAppStore(
    (s) => s.workspaceRuntimeById[catalogWorkspaceId ?? ""]?.pluginViewMode ?? "plugins",
  );
  const setPluginViewMode = useAppStore((s) => s.setPluginViewMode);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setSearchQuery("");
  }, []);

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
      <div className="flex items-center justify-between gap-4 px-6 py-2.5 border-b border-border/50">
        <div className="inline-flex rounded-lg border border-border/60 bg-muted/20 p-1">
          <Button
            size="sm"
            variant={pluginViewMode === "plugins" ? "secondary" : "ghost"}
            className="h-7 rounded-md px-2.5 text-xs"
            onClick={() => void setPluginViewMode("plugins")}
          >
            Plugins
          </Button>
          <Button
            size="sm"
            variant={pluginViewMode === "skills" ? "secondary" : "ghost"}
            className="h-7 rounded-md px-2.5 text-xs"
            onClick={() => void setPluginViewMode("skills")}
          >
            Skills
          </Button>
        </div>
        <div className="relative w-48">
          <SearchIcon className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={pluginViewMode === "skills" ? "Search skills" : "Search plugins"}
            className="h-7 border-transparent bg-muted/30 pl-8 text-xs focus-visible:border-ring focus-visible:bg-background"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {pluginViewMode === "plugins" ? (
          <PluginsCatalogPage
            workspaceId={catalogWorkspaceId}
            managementScope={managementScope}
            searchQuery={searchQuery}
          />
        ) : (
          <SkillsCatalogPage
            workspaceId={catalogWorkspaceId}
            managementScope={managementScope}
            searchQuery={searchQuery}
          />
        )}
      </div>
    </div>
  );
}
