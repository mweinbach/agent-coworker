import { useEffect, useMemo, useState } from "react";

import { defaultModelForProvider } from "@cowork/providers/catalog";

import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Textarea } from "../../../components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { confirmAction } from "../../../lib/desktopCommands";
import { MODEL_CHOICES, modelOptionsForProvider, UI_DISABLED_PROVIDERS } from "../../../lib/modelChoices";
import type { MCPServerConfig, ProviderName } from "../../../lib/wsProtocol";
import { PROVIDER_NAMES } from "../../../lib/wsProtocol";

function displayProviderName(provider: ProviderName): string {
  const names: Partial<Record<ProviderName, string>> = {
    google: "Google",
    openai: "OpenAI",
    anthropic: "Anthropic",
    "codex-cli": "Codex CLI",  };
  return names[provider] ?? provider;
}

function toBoolean(checked: boolean | "indeterminate"): boolean {
  return checked === true;
}

function describeTransport(server: MCPServerConfig): string {
  const transport = server.transport;
  if (transport.type === "stdio") {
    const args = Array.isArray(transport.args) ? ` ${transport.args.join(" ")}` : "";
    return `stdio: ${transport.command}${args}`;
  }
  if (transport.type === "http" || transport.type === "sse") {
    return `${transport.type}: ${transport.url}`;
  }
  return transport.type;
}

export function WorkspacesPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const restartWorkspaceServer = useAppStore((s) => s.restartWorkspaceServer);
  const requestWorkspaceMcpServers = useAppStore((s) => s.requestWorkspaceMcpServers);
  const saveWorkspaceMcpServers = useAppStore((s) => s.saveWorkspaceMcpServers);

  const ws = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const wsRuntime = ws ? workspaceRuntimeById[ws.id] : null;

  const provider = (ws?.defaultProvider ?? "google") as ProviderName;
  const model = (ws?.defaultModel ?? "").trim();
  const subAgentModel = (ws?.defaultSubAgentModel ?? ws?.defaultModel ?? "").trim();
  const enableMcp = ws?.defaultEnableMcp ?? true;
  const yolo = ws?.yolo ?? false;

  const curatedModels = MODEL_CHOICES[provider] ?? [];
  const modelOptions = modelOptionsForProvider(provider, model);
  const hasCustomModel = Boolean(model && !curatedModels.includes(model));
  const subAgentModelOptions = modelOptionsForProvider(provider, subAgentModel);
  const hasCustomSubAgentModel = Boolean(subAgentModel && !curatedModels.includes(subAgentModel));

  const [mcpDraft, setMcpDraft] = useState("");
  const [mcpDraftDirty, setMcpDraftDirty] = useState(false);

  useEffect(() => {
    if (!ws) {
      setMcpDraft("");
      setMcpDraftDirty(false);
      return;
    }
    const rawJson = wsRuntime?.mcpRawJson ?? "";
    setMcpDraft(rawJson);
    setMcpDraftDirty(false);
    void requestWorkspaceMcpServers(ws.id);
  }, [ws?.id]);

  useEffect(() => {
    if (!ws) return;
    const rawJson = wsRuntime?.mcpRawJson ?? "";
    if (!mcpDraftDirty) {
      setMcpDraft(rawJson);
      return;
    }
    if (mcpDraft === rawJson) {
      setMcpDraftDirty(false);
    }
  }, [ws?.id, wsRuntime?.mcpRawJson]);

  const mcpConfigPath = wsRuntime?.mcpConfigPath ?? (ws ? `${ws.path.replace(/\/+$/, "")}/.agent/mcp-servers.json` : null);
  const mcpProjectServers = wsRuntime?.mcpProjectServers ?? [];
  const mcpEffectiveServers = wsRuntime?.mcpEffectiveServers ?? [];
  const mcpParseError = wsRuntime?.mcpParseError ?? null;
  const mcpSaving = wsRuntime?.mcpSaving ?? false;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Workspaces</h1>
        <p className="text-sm text-muted-foreground">Choose a project folder and configure how the agent behaves in it.</p>
      </div>

      {workspaces.length === 0 || !ws ? (
        <Card className="border-border/80 bg-card/85">
          <CardContent className="p-8 text-center">
            <Button type="button" onClick={() => void addWorkspace()}>
              Add workspace
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="border-border/80 bg-card/85">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Active workspace</CardTitle>
                <CardDescription>Selected project for this desktop session.</CardDescription>
              </div>
              <Button variant="outline" type="button" onClick={() => void addWorkspace()}>
                Add
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <div className="text-sm font-medium text-foreground">{ws.name}</div>
                <div className="text-xs text-muted-foreground">{ws.path}</div>
              </div>
              {workspaces.length > 1 ? (
                <Select value={ws.id} onValueChange={(value) => void selectWorkspace(value)}>
                  <SelectTrigger aria-label="Active workspace">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-border/80 bg-card/85">
            <CardHeader>
              <CardTitle>Model</CardTitle>
              <CardDescription>The default provider and model for new sessions in this workspace.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">Provider</div>
                <Select
                  value={provider}
                  onValueChange={(value) => {
                    if (!ws) return;
                    const nextProvider = value as ProviderName;
                    if (UI_DISABLED_PROVIDERS.has(nextProvider)) return;
                    void updateWorkspaceDefaults(ws.id, {
                      defaultProvider: nextProvider,
                      defaultModel: defaultModelForProvider(nextProvider),
                      defaultSubAgentModel: defaultModelForProvider(nextProvider),
                    });
                  }}
                >
                  <SelectTrigger aria-label="Default provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_NAMES.filter((entry) => !UI_DISABLED_PROVIDERS.has(entry)).map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {displayProviderName(entry)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">Primary model</div>
                <Select
                  value={model}
                  onValueChange={(value) => {
                    if (!ws) return;
                    void updateWorkspaceDefaults(ws.id, { defaultModel: value });
                  }}
                >
                  <SelectTrigger aria-label="Default model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {hasCustomModel && entry === model ? `${entry} (custom)` : entry}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">Subagent model</div>
                <Select
                  value={subAgentModel}
                  onValueChange={(value) => {
                    if (!ws) return;
                    void updateWorkspaceDefaults(ws.id, { defaultSubAgentModel: value });
                  }}
                >
                  <SelectTrigger aria-label="Default subagent model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {subAgentModelOptions.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {hasCustomSubAgentModel && entry === subAgentModel ? `${entry} (custom)` : entry}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/80 bg-card/85">
            <CardHeader>
              <CardTitle>Behavior</CardTitle>
              <CardDescription>Execution and visibility options for this workspace.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                <div>
                  <div className="text-sm font-medium">MCP tools</div>
                  <div className="text-xs text-muted-foreground">Allow the agent to use MCP servers configured for this workspace.</div>
                </div>
                <Checkbox
                  checked={enableMcp}
                  aria-label="Enable MCP tools"
                  onCheckedChange={(checked) => {
                    if (!ws) return;
                    void updateWorkspaceDefaults(ws.id, { defaultEnableMcp: toBoolean(checked) });
                  }}
                />
              </div>

              <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                <div>
                  <div className="text-sm font-medium">Auto-approve commands</div>
                  <div className="text-xs text-muted-foreground">Skip confirmation prompts for shell commands.</div>
                </div>
                <Checkbox
                  checked={yolo}
                  aria-label="Enable auto-approve commands"
                  onCheckedChange={async (checked) => {
                    if (!ws) return;
                    const next = toBoolean(checked);
                    const confirmed = await confirmAction({
                      title: next ? "Enable auto-approve commands" : "Disable auto-approve commands",
                      message: next
                        ? "Enable auto-approve? The agent will run commands without asking."
                        : "Disable auto-approve?",
                      confirmLabel: next ? "Enable" : "Disable",
                      cancelLabel: "Cancel",
                      kind: "warning",
                      defaultAction: "cancel",
                    });
                    if (confirmed) {
                      void updateWorkspaceDefaults(ws.id, { yolo: next }).then(() => restartWorkspaceServer(ws.id));
                    }
                  }}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/80 bg-card/85">
            <CardHeader>
              <CardTitle>MCP servers</CardTitle>
              <CardDescription>
                Edit the workspace-local MCP server config JSON and reload effective server state.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">Config path</div>
                <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
                  {mcpConfigPath ?? "(unavailable)"}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">Raw JSON</div>
                <Textarea
                  value={mcpDraft}
                  className="min-h-56 font-mono text-xs"
                  spellCheck={false}
                  aria-label="Workspace MCP JSON editor"
                  onChange={(event) => {
                    setMcpDraft(event.target.value);
                    setMcpDraftDirty(true);
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => ws && void requestWorkspaceMcpServers(ws.id)}
                  >
                    Reload
                  </Button>
                  <Button
                    type="button"
                    onClick={() => ws && void saveWorkspaceMcpServers(ws.id, mcpDraft)}
                    disabled={!ws || mcpSaving || (!mcpDraftDirty && mcpDraft === (wsRuntime?.mcpRawJson ?? ""))}
                  >
                    {mcpSaving ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>

              {mcpParseError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Parse error: {mcpParseError}
                </div>
              ) : null}

              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">
                  Effective servers <span className="text-xs text-muted-foreground">({mcpEffectiveServers.length})</span>
                </div>
                {mcpEffectiveServers.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No MCP servers are currently active.</div>
                ) : (
                  <div className="space-y-2">
                    {mcpEffectiveServers.map((server) => {
                      const isProjectServer = mcpProjectServers.some((project) => project.name === server.name);
                      return (
                        <div
                          key={server.name}
                          className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground">{server.name}</span>
                            <Badge variant={isProjectServer ? "default" : "secondary"}>
                              {isProjectServer ? "workspace" : "inherited"}
                            </Badge>
                          </div>
                          <div className="mt-1 font-mono text-muted-foreground">{describeTransport(server)}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/80 bg-card/85">
            <CardHeader>
              <CardTitle>Advanced</CardTitle>
              <CardDescription>Maintenance and destructive actions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-3 max-[960px]:items-start max-[960px]:flex-col">
                <div>
                  <div className="text-sm font-medium">Restart server</div>
                  <div className="text-xs text-muted-foreground">Restart the workspace agent server if unresponsive.</div>
                </div>
                <Button variant="outline" type="button" onClick={() => void restartWorkspaceServer(ws.id)}>
                  Restart
                </Button>
              </div>

              <div className="flex items-center justify-between gap-3 max-[960px]:items-start max-[960px]:flex-col">
                <div>
                  <div className="text-sm font-medium">Remove workspace</div>
                  <div className="text-xs text-muted-foreground">Remove this workspace from the app. Your files on disk are not affected.</div>
                </div>
                <Button
                  variant="destructive"
                  type="button"
                  onClick={async () => {
                    const confirmed = await confirmAction({
                      title: "Remove workspace",
                      message: `Remove workspace \"${ws.name}\"?`,
                      detail: "Your files on disk will not be affected.",
                      confirmLabel: "Remove",
                      cancelLabel: "Cancel",
                      kind: "warning",
                      defaultAction: "cancel",
                    });
                    if (confirmed) {
                      void removeWorkspace(ws.id);
                    }
                  }}
                >
                  Remove
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>Current provider:</span>
            <Badge variant="secondary">{displayProviderName(provider)}</Badge>
            <span>Model:</span>
            <Badge variant="secondary">{model}</Badge>
            <span>Subagent:</span>
            <Badge variant="secondary">{subAgentModel || model}</Badge>
          </div>
        </>
      )}
    </div>
  );
}
