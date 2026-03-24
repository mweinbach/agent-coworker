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
    <div className="mb-6 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-[2rem] font-semibold tracking-tight">Skills</h1>
          <p className="text-sm text-muted-foreground">
            Give Codex superpowers. <a href="#" className="text-primary hover:underline">Learn more</a>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void refreshSkillsCatalog()}
          >
            <RefreshCwIcon className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <div className="relative w-60">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search skills"
              className="h-8 border-transparent bg-muted/30 pl-9 focus-visible:bg-background focus-visible:border-ring"
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
