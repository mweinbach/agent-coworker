import { DownloadIcon } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import type { MarketplaceSkillCatalogEntry } from "../../lib/wsProtocol";
import { SkillIcon } from "./utils";

export function AvailableSkillCardGrid({
  skills,
  onInstall,
  installing,
}: {
  skills: MarketplaceSkillCatalogEntry[];
  onInstall: (skill: MarketplaceSkillCatalogEntry) => void;
  installing: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {skills.map((skill) => {
        const displayName = skill.interface?.displayName || skill.displayName || skill.name;
        const description = skill.interface?.shortDescription || skill.description;
        const icon = skill.interface?.iconSmall || skill.interface?.iconLarge || "📦";

        return (
          <Card
            key={skill.id}
            className="group relative flex h-full w-full flex-col overflow-hidden border border-border/55 bg-card/44 p-3.5"
          >
            <div className="mb-2.5 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-muted/35 text-lg">
                <SkillIcon icon={icon} />
              </div>
              <div className="min-w-0">
                <div className="truncate font-semibold text-sm text-foreground">{displayName}</div>
                <div className="truncate text-xs text-muted-foreground">{skill.category}</div>
              </div>
            </div>
            <div className="mb-3 flex-1 line-clamp-2 text-xs text-muted-foreground">
              {description}
            </div>
            <div className="mt-auto flex items-center justify-between gap-2">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                {skill.marketplace.displayName ?? skill.marketplace.name}
              </Badge>
              <Button
                size="sm"
                variant="secondary"
                className="h-7 px-2 text-xs"
                disabled={installing}
                onClick={() => onInstall(skill)}
              >
                <DownloadIcon className="mr-1.5 h-3.5 w-3.5" />
                Install
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
