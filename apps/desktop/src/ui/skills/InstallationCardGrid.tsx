import { useAppStore } from "../../app/store";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { CheckIcon } from "lucide-react";
import type { SkillInstallationEntry } from "../../lib/wsProtocol";
import { scopeLabel, stateTone, SkillIcon } from "./utils";

export function InstallationCardGrid({
  installations,
  onSelect,
}: {
  installations: SkillInstallationEntry[];
  onSelect: (installationId: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {installations.map((installation) => {
        const displayName = installation.interface?.displayName || installation.name;
        const description = installation.interface?.shortDescription || installation.description;
        const icon = installation.interface?.iconSmall || installation.interface?.iconLarge || "📦";
        const isEffective = installation.state === "effective";

        return (
          <Card
            key={installation.installationId}
            className="group relative flex cursor-pointer flex-col overflow-hidden border border-border/50 bg-card/50 p-4 transition-colors hover:bg-card/80 hover:border-border/80"
            onClick={() => onSelect(installation.installationId)}
          >
            <div className="flex items-start justify-between gap-4 mb-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/50 border border-border/50 text-xl overflow-hidden">
                  <SkillIcon icon={icon} />
                </div>
                <div className="min-w-0">
                  <div className="truncate font-semibold text-sm text-foreground">
                    {displayName}
                  </div>
                  <div className="truncate text-xs text-muted-foreground flex items-center gap-1.5">
                    <span>{scopeLabel(installation.scope)}</span>
                    {installation.origin?.kind && (
                      <>
                        <span>·</span>
                        <span>{installation.origin.kind}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              {isEffective && (
                <div className="text-muted-foreground">
                  <CheckIcon className="h-4 w-4" />
                </div>
              )}
            </div>
            <div className="text-xs text-muted-foreground line-clamp-2 mb-3 flex-1">
              {description}
            </div>
            <div className="flex items-center gap-2 mt-auto">
              {!isEffective && (
                <Badge variant={stateTone(installation.state)} className="text-[10px] px-1.5 py-0">
                  {installation.state}
                </Badge>
              )}
              {!installation.writable && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">Read-only</Badge>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
