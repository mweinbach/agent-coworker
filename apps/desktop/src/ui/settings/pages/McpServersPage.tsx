import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  ServerIcon,
  SettingsIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "../../../app/store";
import type { WorkspaceRuntime } from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import { confirmAction } from "../../../lib/desktopCommands";
import { cn } from "../../../lib/utils";
import type { MCPServerConfig } from "../../../lib/wsProtocol";
import { EntityIcon, SettingsEmptyState, SettingsSection } from "../SettingsPrimitives";
import {
  buildServerFromDraft,
  type DraftState,
  defaultDraftState,
  draftFromServer,
  formatTransport,
  sourceLabel,
  toBool,
} from "./mcpServerDraft";
import {
  createMcpAutoValidateScheduler,
  type EditorState,
  getMcpEditorSubmitLabel,
  getMcpEditorTitle,
  getPreviousNameForUpsert,
} from "./mcpServerEditorState";

type RuntimeMcpServer = WorkspaceRuntime["mcpServers"][number];

function credentialDraftKey(workspaceId: string, serverName: string): string {
  return `${workspaceId}::${serverName}`;
}

function serverIdentityKey(server: Pick<RuntimeMcpServer, "name" | "source">): string {
  return `${server.source}:${server.name}`;
}

const SOURCE_ORDER: Record<string, number> = {
  user: 0,
  workspace: 1,
  plugin: 2,
  system: 3,
};

function serverSortKey(server: { name: string; source: string }): string {
  const order = SOURCE_ORDER[server.source] ?? 9;
  return `${order}:${server.name.toLowerCase()}`;
}

export function McpServersPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const requestWorkspaceMcpServers = useAppStore((s) => s.requestWorkspaceMcpServers);
  const upsertWorkspaceMcpServer = useAppStore((s) => s.upsertWorkspaceMcpServer);
  const deleteWorkspaceMcpServer = useAppStore((s) => s.deleteWorkspaceMcpServer);
  const setWorkspaceMcpServerEnabled = useAppStore((s) => s.setWorkspaceMcpServerEnabled);
  const validateWorkspaceMcpServer = useAppStore((s) => s.validateWorkspaceMcpServer);
  const authorizeWorkspaceMcpServerAuth = useAppStore((s) => s.authorizeWorkspaceMcpServerAuth);
  const callbackWorkspaceMcpServerAuth = useAppStore((s) => s.callbackWorkspaceMcpServerAuth);
  const setWorkspaceMcpServerApiKey = useAppStore((s) => s.setWorkspaceMcpServerApiKey);

  const workspace = useMemo(
    () => workspaces.find((entry) => entry.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [workspaces, selectedWorkspaceId],
  );
  const runtime = workspace ? workspaceRuntimeById[workspace.id] : null;

  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [draft, setDraft] = useState<DraftState>(defaultDraftState);
  const [oauthCodeByName, setOauthCodeByName] = useState<Record<string, string>>({});
  const [apiKeyByName, setApiKeyByName] = useState<Record<string, string>>({});
  const [expandedServers, setExpandedServers] = useState<Record<string, boolean>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const autoValidateSchedulerRef = useRef(
    createMcpAutoValidateScheduler((workspaceId: string, name: string) => {
      void validateWorkspaceMcpServer(workspaceId, name);
    }),
  );

  const clearAutoValidateTimer = useCallback(() => {
    autoValidateSchedulerRef.current.cancel();
  }, []);

  const isCreating = editorState?.mode === "create";

  useEffect(() => {
    if (!workspace) return;
    clearAutoValidateTimer();
    setEditorState(null);
    setDraft(defaultDraftState());
    void requestWorkspaceMcpServers(workspace.id);
  }, [workspace?.id, requestWorkspaceMcpServers, workspace, clearAutoValidateTimer]);

  useEffect(() => clearAutoValidateTimer, [clearAutoValidateTimer]);

  const servers = useMemo(
    () =>
      [...(runtime?.mcpServers ?? [])].sort((left, right) =>
        serverSortKey(left).localeCompare(serverSortKey(right)),
      ),
    [runtime?.mcpServers],
  );
  const files = runtime?.mcpFiles ?? [];
  const warnings = runtime?.mcpWarnings ?? [];
  const validationByName = runtime?.mcpValidationByName ?? {};

  const resetDraft = ({ clearAutoValidate = true }: { clearAutoValidate?: boolean } = {}) => {
    if (clearAutoValidate) clearAutoValidateTimer();
    setEditorState(null);
    setDraft(defaultDraftState());
  };

  const openCreateEditor = () => {
    if (isCreating) {
      resetDraft();
      return;
    }
    clearAutoValidateTimer();
    setEditorState({ mode: "create" });
    setDraft(defaultDraftState());
  };

  const openEditEditor = (server: MCPServerConfig) => {
    clearAutoValidateTimer();
    setEditorState({ mode: "edit", name: server.name });
    setDraft(draftFromServer(server));
  };

  const toggleExpand = (key: string) => {
    setExpandedServers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const [parent] = useAutoAnimate();

  return (
    <SettingsSection
      title="MCP servers"
      description="Model Context Protocol servers from every config layer: user, workspace, plugin, and system."
      action={
        workspace ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onPointerDown={openCreateEditor}
            onClick={openCreateEditor}
          >
            <PlusIcon data-icon="inline-start" />
            Add server
          </Button>
        ) : undefined
      }
    >
      {workspace ? (
        <Dialog
          open={editorState !== null}
          onOpenChange={(open) => {
            if (!open && editorState === null) return;
            if (!open) resetDraft();
          }}
        >
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{getMcpEditorTitle(editorState)}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Input
                  placeholder="Server name"
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                />
                <Select
                  value={draft.transportType}
                  onValueChange={(value) =>
                    setDraft((prev) => ({
                      ...prev,
                      transportType: value as DraftState["transportType"],
                    }))
                  }
                >
                  <SelectTrigger aria-label="Transport type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">stdio</SelectItem>
                    <SelectItem value="http">http</SelectItem>
                    <SelectItem value="sse">sse</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {draft.transportType === "stdio" ? (
                <>
                  <div className="grid gap-3 md:grid-cols-3">
                    <Input
                      placeholder="Command"
                      value={draft.command}
                      onChange={(event) =>
                        setDraft((prev) => ({ ...prev, command: event.target.value }))
                      }
                    />
                    <Input
                      placeholder="Args (shell-style, optional)"
                      value={draft.args}
                      onChange={(event) =>
                        setDraft((prev) => ({ ...prev, args: event.target.value }))
                      }
                    />
                    <Input
                      placeholder="CWD (optional)"
                      value={draft.cwd}
                      onChange={(event) =>
                        setDraft((prev) => ({ ...prev, cwd: event.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">
                      Environment variables (one KEY=VALUE per line, optional)
                    </div>
                    <Textarea
                      placeholder={"API_TOKEN=secret\nDEBUG=1"}
                      aria-label="Environment variables"
                      className="min-h-16 font-mono text-xs"
                      value={draft.env}
                      onChange={(event) =>
                        setDraft((prev) => ({ ...prev, env: event.target.value }))
                      }
                    />
                  </div>
                </>
              ) : (
                <>
                  <Input
                    placeholder="Server URL"
                    value={draft.url}
                    onChange={(event) => setDraft((prev) => ({ ...prev, url: event.target.value }))}
                  />
                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">
                      HTTP headers (one KEY=VALUE per line, optional)
                    </div>
                    <Textarea
                      placeholder={"x-tenant=team-a\nauthorization=Bearer token"}
                      aria-label="HTTP headers"
                      className="min-h-16 font-mono text-xs"
                      value={draft.headers}
                      onChange={(event) =>
                        setDraft((prev) => ({ ...prev, headers: event.target.value }))
                      }
                    />
                  </div>
                </>
              )}

              <div className="grid gap-3 md:grid-cols-2">
                <Input
                  placeholder="Icon URL (optional)"
                  aria-label="Icon URL"
                  value={draft.icon}
                  onChange={(event) => setDraft((prev) => ({ ...prev, icon: event.target.value }))}
                />
                <Input
                  placeholder="Retries (optional)"
                  value={draft.retries}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, retries: event.target.value }))
                  }
                />
              </div>

              <div className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2">
                <span className="text-sm">Required server</span>
                <Switch
                  aria-label="Required server"
                  checked={draft.required}
                  onCheckedChange={(checked) =>
                    setDraft((prev) => ({ ...prev, required: toBool(checked) }))
                  }
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <Select
                  value={draft.authType}
                  onValueChange={(value) =>
                    setDraft((prev) => ({ ...prev, authType: value as DraftState["authType"] }))
                  }
                >
                  <SelectTrigger aria-label="Auth type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">none</SelectItem>
                    <SelectItem value="api_key">api_key</SelectItem>
                    <SelectItem value="oauth">oauth</SelectItem>
                  </SelectContent>
                </Select>

                {draft.authType === "oauth" ? (
                  <Select
                    value={draft.oauthMode}
                    onValueChange={(value) =>
                      setDraft((prev) => ({ ...prev, oauthMode: value as "auto" | "code" }))
                    }
                  >
                    <SelectTrigger aria-label="OAuth mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">auto</SelectItem>
                      <SelectItem value="code">code</SelectItem>
                    </SelectContent>
                  </Select>
                ) : null}
              </div>

              {draft.authType === "api_key" ? (
                <div className="grid gap-3 md:grid-cols-3">
                  <Input
                    placeholder="Header name (optional)"
                    value={draft.headerName}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, headerName: event.target.value }))
                    }
                  />
                  <Input
                    placeholder="Prefix (optional)"
                    value={draft.prefix}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, prefix: event.target.value }))
                    }
                  />
                  <Input
                    placeholder="Key id (optional)"
                    value={draft.keyId}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, keyId: event.target.value }))
                    }
                  />
                </div>
              ) : null}

              {draft.authType === "oauth" ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <Input
                    placeholder="Scope (optional)"
                    value={draft.scope}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, scope: event.target.value }))
                    }
                  />
                  <Input
                    placeholder="Resource (optional)"
                    value={draft.resource}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, resource: event.target.value }))
                    }
                  />
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    if (!workspace) return;
                    const next = buildServerFromDraft(draft);
                    if (!next) return;
                    const workspaceId = workspace.id;
                    const previousName = getPreviousNameForUpsert(editorState);
                    void upsertWorkspaceMcpServer(workspaceId, next, previousName, "user");
                    autoValidateSchedulerRef.current.schedule(workspaceId, next.name);
                    resetDraft({ clearAutoValidate: false });
                  }}
                >
                  {getMcpEditorSubmitLabel(editorState)}
                </Button>
                <Button type="button" variant="outline" onClick={() => resetDraft()}>
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      <div ref={parent}>
        {servers.length === 0 ? (
          <div className="p-4">
            <SettingsEmptyState
              icon={<ServerIcon />}
              title="No MCP servers configured"
              description="Add a server to give Cowork extra tools, or install a plugin that ships one."
              action={
                workspace ? (
                  <Button type="button" variant="outline" size="sm" onClick={openCreateEditor}>
                    <PlusIcon data-icon="inline-start" />
                    Add server
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : null}
        {servers.map((server) => {
          const serverKey = serverIdentityKey(server);
          const draftKey = workspace ? credentialDraftKey(workspace.id, server.name) : server.name;
          const validation = validationByName[server.name];
          const canEdit = server.source === "user";
          const apiKeyDraft = apiKeyByName[draftKey] ?? "";
          const oauthCode = oauthCodeByName[draftKey] ?? "";
          const isExpanded = expandedServers[serverKey] ?? false;
          const serverEnabled = server.enabled !== false;
          const canToggle =
            server.source !== "system" &&
            (server.source !== "plugin" ||
              (Boolean(server.pluginId) && Boolean(server.pluginScope)));

          return (
            <div
              key={serverKey}
              className={cn(
                "border-b border-border/45 last:border-b-0",
                isExpanded && "bg-card/40",
              )}
            >
              <div className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-card/60">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => toggleExpand(serverKey)}
                >
                  {isExpanded ? (
                    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <EntityIcon src={server.icon} name={server.name} size="sm" />
                  <span className="truncate text-sm font-medium text-foreground">
                    {server.name}
                  </span>
                  <Badge variant="secondary" className="h-5 text-[10px] uppercase">
                    {sourceLabel(server.source)}
                  </Badge>
                  {!serverEnabled ? (
                    <Badge variant="secondary" className="h-5 text-[10px] uppercase">
                      Disabled
                    </Badge>
                  ) : null}
                  {validation?.ok ? (
                    <CheckCircle2Icon className="size-4 shrink-0 text-success" />
                  ) : validation && !validation.ok ? (
                    <XCircleIcon className="size-4 shrink-0 text-destructive" />
                  ) : null}
                </button>

                <div className="flex shrink-0 items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {serverEnabled ? "Enabled" : "Disabled"}
                    </span>
                    <Switch
                      checked={serverEnabled}
                      disabled={!canToggle}
                      aria-label={`Enable ${server.name}`}
                      onCheckedChange={(enabled) => {
                        if (!workspace || !canToggle) return;
                        void setWorkspaceMcpServerEnabled(workspace.id, {
                          name: server.name,
                          source: server.source,
                          enabled,
                          ...(server.pluginId ? { pluginId: server.pluginId } : {}),
                          ...(server.pluginScope ? { pluginScope: server.pluginScope } : {}),
                        });
                      }}
                    />
                  </div>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${server.name}`}
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        openEditEditor(server);
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        openEditEditor(server);
                      }}
                    >
                      <SettingsIcon className="size-4" />
                    </Button>
                  )}
                </div>
              </div>

              {isExpanded && (
                <div className="space-y-4 px-11 pb-4 text-xs">
                  <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Command
                    </span>
                    <span className="inline-block w-fit rounded bg-muted/30 px-2 py-1 font-mono text-[11px]">
                      {formatTransport(server)}
                    </span>
                  </div>

                  <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Auth Mode
                    </span>
                    <span className="text-[13px] text-foreground">{server.authMode}</span>
                  </div>

                  {server.authMessage && (
                    <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Auth Status
                      </span>
                      <span className="text-[13px] text-foreground">{server.authMessage}</span>
                    </div>
                  )}

                  {validation && (
                    <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Last Check
                      </span>
                      <span className="text-[13px] text-foreground">
                        {validation.ok ? "Passed" : "Failed"} ({validation.mode})
                        {typeof validation.toolCount === "number"
                          ? ` • ${validation.toolCount} tools`
                          : ""}
                        {typeof validation.latencyMs === "number"
                          ? ` • ${validation.latencyMs}ms`
                          : ""}
                      </span>
                    </div>
                  )}

                  {validation?.ok &&
                    Array.isArray(validation.tools) &&
                    validation.tools.length > 0 && (
                      <div className="mt-2 grid grid-cols-[120px_1fr] items-start gap-2">
                        <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                          Available Tools
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {validation.tools.map((t) => (
                            <div
                              key={t.name}
                              className="group relative flex cursor-default items-center rounded-sm border border-border/50 bg-muted/40 px-2 py-0.5 font-mono text-xs text-foreground"
                              title={t.description || t.name}
                            >
                              {t.name}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                  <div className="flex items-center gap-2 pt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-7 border-transparent bg-muted/40 text-xs text-foreground shadow-none hover:bg-muted/60"
                      onClick={() =>
                        workspace && void validateWorkspaceMcpServer(workspace.id, server.name)
                      }
                    >
                      Validate Connection
                    </Button>
                    {canEdit && (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="h-7 border-transparent bg-destructive/10 text-xs text-destructive shadow-none hover:bg-destructive/20 hover:text-destructive"
                        onClick={async () => {
                          if (!workspace) return;
                          const confirmed = await confirmAction({
                            title: "Delete server",
                            message: `Delete the "${server.name}" MCP server?`,
                            detail:
                              "This server will be removed from your workspace configuration.",
                            confirmLabel: "Delete",
                            cancelLabel: "Cancel",
                            kind: "warning",
                            defaultAction: "cancel",
                          });
                          if (confirmed) {
                            void deleteWorkspaceMcpServer(workspace.id, server.name, "user");
                          }
                        }}
                      >
                        Delete Server
                      </Button>
                    )}
                  </div>

                  {server.auth?.type === "oauth" ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/50 pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() =>
                          workspace &&
                          void authorizeWorkspaceMcpServerAuth(workspace.id, server.name)
                        }
                      >
                        Sign in
                      </Button>
                      <Input
                        className="h-7 max-w-64 text-xs"
                        placeholder="Paste OAuth code (optional)"
                        value={oauthCode}
                        onChange={(event) =>
                          setOauthCodeByName((prev) => ({
                            ...prev,
                            [draftKey]: event.target.value,
                          }))
                        }
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() =>
                          workspace &&
                          void callbackWorkspaceMcpServerAuth(
                            workspace.id,
                            server.name,
                            oauthCode.trim() ? oauthCode : undefined,
                          )
                        }
                      >
                        Continue
                      </Button>
                    </div>
                  ) : null}

                  {server.auth?.type === "api_key" ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/50 pt-2">
                      <Input
                        className="h-7 max-w-64 text-xs"
                        placeholder="Paste API key"
                        value={apiKeyDraft}
                        onChange={(event) =>
                          setApiKeyByName((prev) => ({ ...prev, [draftKey]: event.target.value }))
                        }
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() =>
                          workspace &&
                          void setWorkspaceMcpServerApiKey(
                            workspace.id,
                            server.name,
                            apiKeyDraft.trim(),
                          )
                        }
                      >
                        Set key
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start gap-2 rounded-none px-4 py-2.5 text-sm font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            <WrenchIcon className="size-4" />
            <span>Config files</span>
            <ChevronDownIcon
              className={cn("ml-auto size-4 transition-transform", advancedOpen && "rotate-180")}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 px-4 pb-4 text-xs">
            {files.map((file) => (
              <div
                key={file.path}
                className="rounded-md border border-border/70 bg-muted/20 px-3 py-2"
              >
                <div className="font-medium text-foreground">
                  {sourceLabel(file.source)} {file.editable ? "(editable)" : "(read-only)"}
                </div>
                <div className="font-mono text-muted-foreground">{file.path}</div>
                <div className="text-muted-foreground">
                  exists={String(file.exists)}, servers={file.serverCount}
                </div>
                {file.parseError ? (
                  <div className="text-destructive">parse error: {file.parseError}</div>
                ) : null}
              </div>
            ))}
            {warnings.length > 0 ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                {warnings.join(" | ")}
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SettingsSection>
  );
}
