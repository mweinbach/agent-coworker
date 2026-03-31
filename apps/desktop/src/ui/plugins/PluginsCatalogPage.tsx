import { useMemo, useState } from "react";
import { useAppStore } from "../../app/store";
import { PluginCardGrid } from "./PluginCardGrid";
import { PluginDetailDialog } from "./PluginDetailDialog";
import { InstallPluginDialog } from "./InstallPluginDialog";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { MessageSquareIcon, RefreshCwIcon, SearchIcon } from "lucide-react";

export function PluginsCatalogPage({
  workspaceId,
  managementScope = "workspace",
}: {
  workspaceId: string;
  managementScope?: "workspace" | "global";
}) {
  const wsRtById = useAppStore((s) => s.workspaceRuntimeById);
  const refreshPluginsCatalog = useAppStore((s) => s.refreshPluginsCatalog);
  const selectPlugin = useAppStore((s) => s.selectPlugin);
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectThread = useAppStore((s) => s.selectThread);
  const newThread = useAppStore((s) => s.newThread);

  const [searchQuery, setSearchQuery] = useState("");

  const rt = wsRtById[workspaceId];
  const catalog = rt?.pluginsCatalog ?? null;
  const pluginsLoading = rt?.pluginsLoading ?? false;
  const pluginsError = rt?.pluginsError ?? null;
  const showLoadingState = pluginsLoading && catalog === null;

  const workspace = useMemo(
    () => workspaces.find((entry) => entry.id === workspaceId) ?? null,
    [workspaceId, workspaces],
  );

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

  const sessionLabel = workspaceThreads.length === 1 ? "1 session" : `${workspaceThreads.length} sessions`;
  const chatButtonLabel = workspaceThreads.length > 0 ? "Open chat" : "New thread";

  const handleOpenChat = async () => {
    if (activeThread) {
      await selectThread(activeThread.id);
      return;
    }
    await newThread({ workspaceId });
  };

  const plugins = useMemo(() => {
    let items = [...(catalog?.plugins ?? [])];
    if (managementScope === "global") {
      items = items.filter((plugin) => plugin.scope === "user");
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      items = items.filter((plugin) =>
        plugin.name.toLowerCase().includes(query)
        || plugin.displayName.toLowerCase().includes(query)
        || plugin.description.toLowerCase().includes(query)
        || plugin.interface?.shortDescription?.toLowerCase().includes(query)
      );
    }
    return items.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [catalog, searchQuery]);

  const enabledPlugins = useMemo(() => plugins.filter((plugin) => plugin.enabled), [plugins]);
  const disabledPlugins = useMemo(() => plugins.filter((plugin) => !plugin.enabled), [plugins]);

  const scopeLabel = managementScope === "global" ? "Global plugins" : "Plugins";
  const ownerLabel = managementScope === "global"
    ? "your global library"
    : workspace?.name ?? "this workspace";
  const emptyLabel = managementScope === "global"
    ? "No Codex-style plugins were discovered in your global library."
    : "No Codex-style plugins were discovered for this workspace.";

  return (
    <div className="app-skills-view h-full min-h-0 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-col gap-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <h1 className="mb-1 text-[2rem] font-semibold tracking-tight">Plugins</h1>
              <p className="text-sm text-muted-foreground">
                {scopeLabel} for <span className="font-medium text-foreground/80">{ownerLabel}</span>
                <span className="mx-2 text-muted-foreground/65">•</span>
                {sessionLabel}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => void handleOpenChat()}
              >
                <MessageSquareIcon className="mr-2 h-4 w-4" />
                {chatButtonLabel}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => void refreshPluginsCatalog()}
              >
                <RefreshCwIcon className="mr-2 h-4 w-4" />
                Refresh
              </Button>
              <InstallPluginDialog workspaceId={workspaceId} />
              <div className="relative w-60">
                <SearchIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search plugins"
                  className="h-8 border-transparent bg-muted/30 pl-9 focus-visible:border-ring focus-visible:bg-background"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-8">
          {enabledPlugins.length > 0 ? (
            <section>
              <h2 className="mb-4 text-lg font-semibold">Enabled</h2>
              <PluginCardGrid plugins={enabledPlugins} onSelect={(pluginId) => void selectPlugin(pluginId)} />
            </section>
          ) : null}

          {disabledPlugins.length > 0 ? (
            <section>
              <h2 className="mb-4 text-lg font-semibold text-muted-foreground">Disabled</h2>
              <PluginCardGrid plugins={disabledPlugins} onSelect={(pluginId) => void selectPlugin(pluginId)} />
            </section>
          ) : null}

          {showLoadingState ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/50 bg-muted/10 py-10 text-center">
              <div className="mb-1 text-base font-medium">Loading...</div>
              <div className="text-sm text-muted-foreground">Fetching plugins catalog.</div>
            </div>
          ) : null}

          {!showLoadingState && pluginsError ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-4 text-left">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="border-destructive/40 text-destructive">
                  Connection issue
                </Badge>
                <span className="text-sm text-destructive">{pluginsError}</span>
              </div>
              <Button size="sm" variant="outline" onClick={() => void refreshPluginsCatalog()}>
                Retry
              </Button>
            </div>
          ) : null}

          {!showLoadingState && !pluginsError && plugins.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/50 bg-muted/10 py-10 text-center">
              <div className="mb-1 text-base font-medium">No plugins found</div>
              <div className="text-sm text-muted-foreground">
                {searchQuery ? "Try adjusting your search query." : emptyLabel}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <PluginDetailDialog workspaceId={workspaceId} />
    </div>
  );
}
