import { ExternalLinkIcon, RefreshCwIcon, SearchXIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";

export function OpenAiNativeConnectorsPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const requestOpenAiNativeConnectors = useAppStore((s) => s.requestOpenAiNativeConnectors);
  const refreshOpenAiNativeConnectors = useAppStore((s) => s.refreshOpenAiNativeConnectors);
  const setOpenAiNativeConnectorEnabled = useAppStore((s) => s.setOpenAiNativeConnectorEnabled);

  const workspace = useMemo(
    () => workspaces.find((entry) => entry.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [workspaces, selectedWorkspaceId],
  );
  const runtime = workspace ? workspaceRuntimeById[workspace.id] : null;
  const connectors = runtime?.openAiNativeConnectors ?? [];
  const loading = runtime?.openAiNativeConnectorsLoading === true;
  const authenticated = runtime?.openAiNativeConnectorsAuthenticated === true;
  const message = runtime?.openAiNativeConnectorsMessage;
  const error = runtime?.openAiNativeConnectorsError;
  const enabledCount = runtime?.openAiNativeConnectorsEnabledIds.length ?? 0;
  const accessibleCount = connectors.filter((connector) => connector.isAccessible === true).length;
  const [query, setQuery] = useState("");
  const [showEnabledOnly, setShowEnabledOnly] = useState(false);

  useEffect(() => {
    if (!workspace) return;
    void requestOpenAiNativeConnectors(workspace.id);
  }, [workspace, requestOpenAiNativeConnectors]);

  const visibleConnectors = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return connectors.filter((connector) => {
      if (showEnabledOnly && !connector.isEnabled) return false;
      if (!normalizedQuery) return true;
      return (
        connector.name.toLowerCase().includes(normalizedQuery) ||
        connector.id.toLowerCase().includes(normalizedQuery) ||
        connector.description?.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [connectors, query, showEnabledOnly]);

  return (
    <div className="space-y-5">
      <Card className="border-border/60 bg-background/60 shadow-none">
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">ChatGPT apps for Codex</CardTitle>
              <CardDescription>
                Enable ChatGPT apps from the Codex app-server for this workspace.
              </CardDescription>
            </div>
            {workspace ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void refreshOpenAiNativeConnectors(workspace.id)}
              >
                <RefreshCwIcon className="mr-2 h-4 w-4" />
                Refresh
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <div className="flex flex-wrap gap-2">
            <Badge variant={authenticated ? "default" : "secondary"}>
              {authenticated ? "Codex authenticated" : "Codex sign-in required"}
            </Badge>
            <Badge variant="secondary">{enabledCount} enabled</Badge>
            <Badge variant="secondary">{accessibleCount} connected</Badge>
          </div>
          {message ? <p>{message}</p> : null}
          {error ? <p className="text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      {!workspace ? (
        <Card className="border-border/60 shadow-none">
          <CardContent className="py-8 text-sm text-muted-foreground">
            Select a workspace to manage native connectors.
          </CardContent>
        </Card>
      ) : connectors.length === 0 ? (
        <Card className="border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
            <SearchXIcon className="h-8 w-8 opacity-60" />
            <div>
              <p className="font-medium text-foreground">No connectors loaded</p>
              <p>Refresh after signing in to Codex or installing ChatGPT apps.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border/60 shadow-none">
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <CardTitle className="text-base">Available connectors</CardTitle>
                <CardDescription>
                  {visibleConnectors.length} of {connectors.length} shown
                </CardDescription>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Enabled only</span>
                <Switch
                  checked={showEnabledOnly}
                  aria-label="Show enabled connectors only"
                  onCheckedChange={setShowEnabledOnly}
                />
              </div>
            </div>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search connectors by name, id, or description"
              aria-label="Search OpenAI native connectors"
            />
          </CardHeader>
          <CardContent className="p-0">
            {visibleConnectors.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
                <SearchXIcon className="h-7 w-7 opacity-60" />
                <p>No connectors match the current filters.</p>
              </div>
            ) : (
              <div className="divide-y divide-border/50">
                {visibleConnectors.map((connector) => (
                  <article
                    key={connector.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.025]"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-medium">{connector.name}</h3>
                        {connector.isWorkspaceConnector ? (
                          <Badge variant="secondary">Workspace</Badge>
                        ) : null}
                        <Badge variant={connector.isAccessible ? "default" : "secondary"}>
                          {connector.isAccessible ? "Connected" : "Directory"}
                        </Badge>
                      </div>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {connector.id}
                      </p>
                      {connector.description ? (
                        <p className="line-clamp-2 max-w-3xl text-sm text-muted-foreground">
                          {connector.description}
                        </p>
                      ) : null}
                      {connector.installUrl ? (
                        <a
                          href={connector.installUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          Manage in ChatGPT
                          <ExternalLinkIcon className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>
                    <div className="flex items-start pt-1">
                      <Switch
                        checked={connector.isEnabled}
                        disabled={!connector.isAccessible}
                        aria-label={`Enable ${connector.name}`}
                        onCheckedChange={(enabled) =>
                          void setOpenAiNativeConnectorEnabled(workspace.id, connector.id, enabled)
                        }
                      />
                    </div>
                  </article>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
