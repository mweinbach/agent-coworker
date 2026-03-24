import { useAppStore } from "../app/store";
import { SkillsCatalogPage } from "./skills";

export function SkillsView() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);

  if (!selectedWorkspaceId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <h2 className="text-[1.75rem] font-semibold tracking-tight">Pick a workspace</h2>
        <p className="text-sm text-muted-foreground">Select a workspace to view available skills.</p>
      </div>
    );
  }

  return <SkillsCatalogPage workspaceId={selectedWorkspaceId} />;
}
