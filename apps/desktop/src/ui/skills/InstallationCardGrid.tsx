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
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {installations.map((installation) => {
        const displayName = installation.interface?.displayName || installation.name;
        const description = installation.interface?.shortDescription || installation.description;
        const icon = installation.interface?.iconSmall || installation.interface?.iconLarge || "📦";
        const isEffective = installation.state === "effective";

        return (
          <Card
            key={installation.installationId}
            className="group relative flex cursor-pointer flex-col overflow-hidden border border-border/55 bg-card/44 p-3.5 transition-colors hover:border-border/75 hover:bg-card/68"
            onClick={() => onSelect(installation.installationId)}
          >
            <div className="mb-2.5 flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-muted/35 text-lg">
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
            <div className="mb-3 flex-1 line-clamp-2 text-xs text-muted-foreground">
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
