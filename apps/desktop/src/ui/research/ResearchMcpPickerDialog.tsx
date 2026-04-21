import { useEffect } from "react";

import { useAppStore } from "../../app/store";
import { Checkbox } from "../../components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";

export function ResearchMcpPickerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useAppStore((s) => s.researchDraftSettings);
  const setResearchDraftSettings = useAppStore((s) => s.setResearchDraftSettings);
  const loadResearchMcpServers = useAppStore((s) => s.loadResearchMcpServers);
  const servers = useAppStore((s) => s.researchMcpServers);
  const loading = useAppStore((s) => s.researchMcpServersLoading);
  const error = useAppStore((s) => s.researchMcpServersError);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadResearchMcpServers();
  }, [loadResearchMcpServers, open]);

  const toggleServer = (name: string, checked: boolean) => {
    const nextNames = checked
      ? Array.from(new Set([...settings.mcpServerNames, name]))
      : settings.mcpServerNames.filter((serverName) => serverName !== name);
    setResearchDraftSettings({ mcpServerNames: nextNames });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Select MCP servers</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            These selections are stored now and will use each server's existing auth once Google enables MCP pass-through in Deep Research.
          </div>

          {error ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="max-h-[420px] space-y-2 overflow-y-auto">
            {loading && servers.length === 0 ? (
              <div className="rounded-xl border border-border/60 bg-muted/10 px-3 py-4 text-sm text-muted-foreground">
                Loading MCP servers...
              </div>
            ) : null}

            {servers.map((server) => (
              <label
                key={`${server.workspaceId}:${server.source}:${server.name}`}
                className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-card/70 px-3 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{server.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {server.workspaceName} · {server.source} · auth {server.authMode}
                  </div>
                </div>
                <Checkbox
                  checked={settings.mcpServerNames.includes(server.name)}
                  onCheckedChange={(checked) => toggleServer(server.name, checked)}
                  aria-label={`Select ${server.name}`}
                />
              </label>
            ))}

            {!loading && servers.length === 0 ? (
              <div className="rounded-xl border border-border/60 bg-muted/10 px-3 py-4 text-sm text-muted-foreground">
                No MCP servers were found across the available workspaces.
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

