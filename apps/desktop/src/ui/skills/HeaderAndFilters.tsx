import { SearchIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { InstallSkillDialog } from "./InstallSkillDialog";
import { useAppStore } from "../../app/store";

export function HeaderAndFilters({
  workspaceId,
  searchQuery,
  setSearchQuery,
}: {
  workspaceId: string;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}) {
  const refreshSkillsCatalog = useAppStore((s) => s.refreshSkillsCatalog);

  return (
    <div className="flex flex-col gap-6 mb-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight mb-1">Skills</h1>
          <p className="text-muted-foreground">
            Give Codex superpowers. <a href="#" className="text-primary hover:underline">Learn more</a>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void refreshSkillsCatalog()}
          >
            <RefreshCwIcon className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <div className="relative w-64">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search skills"
              className="pl-9 h-9 bg-muted/50 border-transparent focus-visible:bg-background focus-visible:border-ring"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <InstallSkillDialog workspaceId={workspaceId} />
        </div>
      </div>
    </div>
  );
}
