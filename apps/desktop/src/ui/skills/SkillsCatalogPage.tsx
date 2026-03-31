import { useMemo } from "react";
import { MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { InstallationCardGrid } from "./InstallationCardGrid";
import { InstallSkillDialog } from "./InstallSkillDialog";
import { SkillDetailDialog } from "./SkillDetailDialog";

export function SkillsCatalogPage({
  workspaceId,
  managementScope = "workspace",
  searchQuery,
  setSearchQuery,
}: {
  workspaceId: string;
  managementScope?: "workspace" | "global";
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}) {
  const wsRtById = useAppStore((s) => s.workspaceRuntimeById);
  const selectSkillInstallation = useAppStore((s) => s.selectSkillInstallation);
  const refreshSkillsCatalog = useAppStore((s) => s.refreshSkillsCatalog);
  const threads = useAppStore((s) => s.threads);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectThread = useAppStore((s) => s.selectThread);
  const newThread = useAppStore((s) => s.newThread);

  const workspaceThreads = useMemo(
    () =>
      threads
        .filter((thread) => thread.workspaceId === workspaceId)
        .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt)),
    [threads, workspaceId],
  );

  const activeThread = useMemo(() => {
    if (!selectedThreadId) {
      return workspaceThreads[0] ?? null;
    }
    return workspaceThreads.find((thread) => thread.id === selectedThreadId) ?? workspaceThreads[0] ?? null;
  }, [selectedThreadId, workspaceThreads]);

  const chatButtonLabel = workspaceThreads.length > 0 ? "Open chat" : "New thread";

  const handleOpenChat = async () => {
    if (activeThread) {
      await selectThread(activeThread.id);
      return;
    }
    await newThread({ workspaceId });
  };

  const rt = wsRtById[workspaceId];
  const catalog = rt?.skillsCatalog ?? null;
  const skillCatalogLoading = rt?.skillCatalogLoading ?? false;
  const showLoadingState = skillCatalogLoading && catalog === null;

  const installations = useMemo(() => {
    let items = [...(catalog?.installations ?? [])];
    if (managementScope === "global") {
      items = items.filter((installation) => installation.scope === "global");
    }

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
  }, [catalog, managementScope, searchQuery]);

  const effectiveSkills = useMemo(() => {
    return installations.filter((i) => i.state === "effective");
  }, [installations]);

  const otherSkills = useMemo(() => {
    return installations.filter((i) => i.state !== "effective");
  }, [installations]);

  return (
    <div className="app-skills-view h-full min-h-0 overflow-y-auto px-6 py-4">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => void handleOpenChat()}
          >
            <MessageSquareIcon className="mr-1.5 h-4 w-4" />
            {chatButtonLabel}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => void refreshSkillsCatalog()}
          >
            <RefreshCwIcon className="mr-1.5 h-4 w-4" />
            Refresh
          </Button>
          <InstallSkillDialog workspaceId={workspaceId} />
        </div>

        <div className="space-y-6">
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
