import { useMemo, useState } from "react";
import { useAppStore } from "../../app/store";
import { HeaderAndFilters } from "./HeaderAndFilters";
import { InstallationCardGrid } from "./InstallationCardGrid";
import { SkillDetailDialog } from "./SkillDetailDialog";

export function SkillsCatalogPage({ workspaceId }: { workspaceId: string }) {
  const wsRtById = useAppStore((s) => s.workspaceRuntimeById);
  const selectSkillInstallation = useAppStore((s) => s.selectSkillInstallation);

  const [searchQuery, setSearchQuery] = useState("");

  const rt = wsRtById[workspaceId];
  const catalog = rt?.skillsCatalog ?? null;
  const skillCatalogLoading = rt?.skillCatalogLoading ?? false;
  const showLoadingState = skillCatalogLoading && catalog === null;

  const installations = useMemo(() => {
    let items = [...(catalog?.installations ?? [])];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.interface?.displayName?.toLowerCase().includes(q) ||
          i.description?.toLowerCase().includes(q) ||
          i.interface?.shortDescription?.toLowerCase().includes(q)
      );
    }

    return items.sort((left, right) =>
      `${left.name}:${left.scope}:${left.installationId}`.localeCompare(`${right.name}:${right.scope}:${right.installationId}`),
    );
  }, [catalog, searchQuery]);

  const effectiveSkills = useMemo(() => {
    return installations.filter((i) => i.state === "effective");
  }, [installations]);

  const otherSkills = useMemo(() => {
    return installations.filter((i) => i.state !== "effective");
  }, [installations]);

  return (
    <div className="app-skills-view h-full min-h-0 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-6xl">
        <HeaderAndFilters
          workspaceId={workspaceId}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
        />

        <div className="space-y-8">
          {effectiveSkills.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold mb-4">Installed</h2>
              <InstallationCardGrid
                installations={effectiveSkills}
                onSelect={(id) => void selectSkillInstallation(id)}
              />
            </section>
          )}

          {otherSkills.length > 0 && (
            <section>
              <h2 className="mb-4 text-lg font-semibold text-muted-foreground">Other Installations</h2>
              <InstallationCardGrid
                installations={otherSkills}
                onSelect={(id) => void selectSkillInstallation(id)}
              />
            </section>
          )}

          {showLoadingState && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/50 bg-muted/10 py-10 text-center">
              <div className="mb-1 text-base font-medium">Loading...</div>
              <div className="text-sm text-muted-foreground">Fetching skills catalog.</div>
            </div>
          )}

          {!showLoadingState && installations.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/50 bg-muted/10 py-10 text-center">
              <div className="mb-1 text-base font-medium">No skills found</div>
              <div className="text-sm text-muted-foreground">
                {searchQuery ? "Try adjusting your search query." : "Install a skill to give Codex superpowers."}
              </div>
            </div>
          )}
        </div>
      </div>

      <SkillDetailDialog workspaceId={workspaceId} />
    </div>
  );
}
