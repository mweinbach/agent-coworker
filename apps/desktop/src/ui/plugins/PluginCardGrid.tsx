import { PackageIcon } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { isInstalledPluginCatalogEntry, type PluginCatalogEntry } from "../../lib/wsProtocol";
import { SkillIcon } from "../skills/utils";

export function PluginCardGrid({
  plugins,
  onSelect,
}: {
  plugins: PluginCatalogEntry[];
  onSelect: (pluginId: string, scope: PluginCatalogEntry["scope"]) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {plugins.map((plugin) => {
        const icon = plugin.interface?.logo || plugin.interface?.composerIcon;
        const subtitle = plugin.interface?.shortDescription || plugin.description;
        const installed = isInstalledPluginCatalogEntry(plugin);
        return (
          <button
            key={`${plugin.scope}:${plugin.id}`}
            type="button"
            className="w-full text-left"
            onClick={() => onSelect(plugin.id, plugin.scope)}
          >
            <Card className="group relative flex h-full w-full cursor-pointer flex-col overflow-hidden border border-border/55 bg-card/44 p-3.5 transition-colors hover:border-border/75 hover:bg-card/68">
              <div className="mb-2.5 flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-muted/35 text-lg">
                    {icon ? <SkillIcon icon={icon} /> : <PackageIcon className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-sm text-foreground">
                      {plugin.displayName}
                    </div>
                    <div className="truncate text-xs text-muted-foreground flex items-center gap-1.5">
                      <span>
                        {plugin.scope === "workspace" ? "Workspace plugin" : "User plugin"}
                      </span>
                      <span>/</span>
                      <span>
                        {plugin.discoveryKind === "marketplace" ? "Marketplace" : "Direct"}
                      </span>
                    </div>
                  </div>
                </div>
                {!installed ? (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    Available
                  </Badge>
                ) : plugin.enabled ? (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    Enabled
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    Disabled
                  </Badge>
                )}
              </div>
              <div className="mb-3 flex-1 line-clamp-3 text-xs text-muted-foreground">
                {subtitle}
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-2">
                {plugin.marketplace?.category ? (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {plugin.marketplace.category}
                  </Badge>
                ) : null}
                {installed ? (
                  <>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {plugin.skills.length} skills
                    </Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {plugin.mcpServers.length} MCP
                    </Badge>
                  </>
                ) : null}
              </div>
            </Card>
          </button>
        );
      })}
    </div>
  );
}
