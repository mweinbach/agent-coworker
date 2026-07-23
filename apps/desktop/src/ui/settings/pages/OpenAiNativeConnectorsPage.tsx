import { ExternalLinkIcon, RefreshCwIcon, SearchXIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { operationKey } from "../../../app/store.helpers";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Switch } from "../../../components/ui/switch";
import { OperationFeedback } from "../../OperationFeedback";
import {
  EntityIcon,
  SettingsEmptyState,
  SettingsSection,
  SettingsStatusPill,
} from "../SettingsPrimitives";

export function OpenAiNativeConnectorsPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const requestOpenAiNativeConnectors = useAppStore((s) => s.requestOpenAiNativeConnectors);
  const refreshOpenAiNativeConnectors = useAppStore((s) => s.refreshOpenAiNativeConnectors);
  const setOpenAiNativeConnectorEnabled = useAppStore((s) => s.setOpenAiNativeConnectorEnabled);
  const operationsByKey = useAppStore((s) => s.operationsByKey);

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
    <SettingsSection
      title="ChatGPT apps for Codex"
      description="Enable ChatGPT apps from the Codex app-server for the current folder or chat."
      action={
        workspace ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void refreshOpenAiNativeConnectors(workspace.id)}
          >
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <SettingsStatusPill tone={authenticated ? "success" : "warning"}>
          {authenticated ? "Codex authenticated" : "Codex sign-in required"}
        </SettingsStatusPill>
        <SettingsStatusPill tone="neutral">{enabledCount} enabled</SettingsStatusPill>
        <SettingsStatusPill tone="neutral">{accessibleCount} connected</SettingsStatusPill>
        {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>

      {!workspace ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">
          Select a workspace to manage native connectors.
        </div>
      ) : connectors.length === 0 ? (
        <div className="p-4">
          <SettingsEmptyState
            icon={<SearchXIcon />}
            title="No connectors loaded"
            description="Refresh after signing in to Codex or installing ChatGPT apps."
          />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search connectors by name, id, or description"
              aria-label="Search OpenAI native connectors"
              className="h-8 max-w-md"
            />
            <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Label htmlFor="connectors-enabled-only" className="cursor-pointer">
                Enabled only
              </Label>
              <Switch
                id="connectors-enabled-only"
                checked={showEnabledOnly}
                aria-label="Show enabled connectors only"
                onCheckedChange={setShowEnabledOnly}
              />
            </div>
          </div>
          {visibleConnectors.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
              <SearchXIcon className="size-7 opacity-60" />
              <p>No connectors match the current filters.</p>
            </div>
          ) : (
            visibleConnectors.map((connector) => {
              const operation =
                operationsByKey[operationKey("connector", "enabled", workspace.id, connector.id)];
              return (
                <article
                  key={connector.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.025]"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <EntityIcon src={connector.logoUrl} name={connector.name} />
                    <div className="min-w-0 space-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-medium">{connector.name}</h3>
                        {connector.isWorkspaceConnector ? (
                          <SettingsStatusPill tone="neutral">Workspace</SettingsStatusPill>
                        ) : null}
                        <SettingsStatusPill tone={connector.isAccessible ? "success" : "neutral"}>
                          {connector.isAccessible ? "Connected" : "Directory"}
                        </SettingsStatusPill>
                      </div>
                      <p className="truncate font-mono text-xs text-muted-foreground">
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
                          <ExternalLinkIcon className="size-3" />
                        </a>
                      ) : null}
                      <OperationFeedback operation={operation} />
                    </div>
                  </div>
                  <div className="flex items-start pt-1">
                    <Switch
                      checked={connector.isEnabled}
                      disabled={!connector.isAccessible || operation?.status === "pending"}
                      aria-label={`Enable ${connector.name}`}
                      onCheckedChange={(enabled) =>
                        void setOpenAiNativeConnectorEnabled(workspace.id, connector.id, enabled)
                      }
                    />
                  </div>
                </article>
              );
            })
          )}
        </>
      )}
    </SettingsSection>
  );
}
