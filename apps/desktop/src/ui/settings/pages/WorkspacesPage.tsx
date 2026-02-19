import { useMemo } from "react";

import { defaultModelForProvider } from "@cowork/providers/catalog";

import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { confirmAction } from "../../../lib/desktopCommands";
import { MODEL_CHOICES, modelOptionsForProvider, UI_DISABLED_PROVIDERS } from "../../../lib/modelChoices";
import type { ProviderName } from "../../../lib/wsProtocol";
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

export function WorkspacesPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);

  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const restartWorkspaceServer = useAppStore((s) => s.restartWorkspaceServer);
  const developerMode = useAppStore((s) => s.developerMode);
  const setDeveloperMode = useAppStore((s) => s.setDeveloperMode);

  const ws = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const provider = (ws?.defaultProvider ?? "google") as ProviderName;
  const model = (ws?.defaultModel ?? "").trim();
  const enableMcp = ws?.defaultEnableMcp ?? true;
  const yolo = ws?.yolo ?? false;

  const curatedModels = MODEL_CHOICES[provider] ?? [];
  const modelOptions = modelOptionsForProvider(provider, model);
  const hasCustomModel = Boolean(model && !curatedModels.includes(model));

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
                <div className="text-sm font-medium text-foreground">Model</div>
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

              <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                <div>
                  <div className="text-sm font-medium">Developer mode</div>
                  <div className="text-xs text-muted-foreground">Show internal system notices in the chat feed.</div>
                </div>
                <Checkbox
                  checked={developerMode}
                  aria-label="Enable developer mode"
                  onCheckedChange={(checked) => setDeveloperMode(toBoolean(checked))}
                />
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
          </div>
        </>
      )}
    </div>
  );
}
