import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ServerIcon,
  SettingsIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "../../../app/store";
import { operationKey } from "../../../app/store.helpers";
import type { WorkspaceRuntime } from "../../../app/types";
import {
  resolveManagementWorkspaceId,
  resolveProjectWorkspaceId,
} from "../../../app/workspaceDisplayTargets";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import { Field, FieldLabel } from "../../../components/ui/field";
import { Input } from "../../../components/ui/input";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group";
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
import { OperationFeedback } from "../../OperationFeedback";
import { EntityIcon, SettingsEmptyState, SettingsSection } from "../SettingsPrimitives";
import { NoMatchesState } from "../toolAccess/catalogShared";
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
  type EditableMcpSource,
  type EditorState,
  getMcpEditorSubmitLabel,
  getMcpEditorTitle,
  getPreviousNameForUpsert,
} from "./mcpServerEditorState";

type RuntimeMcpServer = WorkspaceRuntime["mcpServers"][number];
type RuntimeMcpServerIdentity = Pick<RuntimeMcpServer, "name" | "source"> &
  Partial<Pick<RuntimeMcpServer, "pluginId" | "pluginScope">>;
type RuntimeMcpPluginTarget = {
  pluginId?: string;
  pluginScope?: "workspace" | "user";
};

function serverIdentityKey(server: RuntimeMcpServerIdentity): string {
  if (server.source === "plugin") {
    return [
      server.source,
      server.pluginScope ?? "unknown-scope",
      server.pluginId ?? "unknown-plugin",
      server.name,
    ].join(":");
  }
  return `${server.source}:${server.name}`;
}

export function mcpCredentialDraftKey(
  workspaceId: string,
  server: RuntimeMcpServerIdentity,
): string {
  return `${workspaceId}::${serverIdentityKey(server)}`;
}

function pluginTargetForServer(
  server: RuntimeMcpServerIdentity,
): RuntimeMcpPluginTarget | undefined {
  if (server.source !== "plugin") return undefined;
  if (!server.pluginId && !server.pluginScope) return undefined;
  return {
    ...(server.pluginId ? { pluginId: server.pluginId } : {}),
    ...(server.pluginScope ? { pluginScope: server.pluginScope } : {}),
  };
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

function editableSource(source: RuntimeMcpServer["source"]): EditableMcpSource | null {
  return source === "user" || source === "workspace" ? source : null;
}

/** Tools register internally as `mcp__{server}__{tool}`; show only the tool name. */
function displayToolName(toolName: string, serverName: string): string {
  const namespacePrefix = `mcp__${serverName}__`;
  return toolName.startsWith(namespacePrefix) ? toolName.slice(namespacePrefix.length) : toolName;
}

const AUTH_MODE_LABELS: Record<string, string> = {
  none: "None",
  missing: "Not connected",
  api_key: "API key",
  oauth: "OAuth",
  oauth_pending: "OAuth sign-in pending",
  error: "Error",
};

function authModeLabel(mode: string): string {
  return AUTH_MODE_LABELS[mode] ?? mode;
}

/**
 * An OAuth connector the user simply hasn't signed in to yet, whose sign-in
 * is still in flight, or whose authorization has expired ("error" is only
 * emitted for OAuth servers when re-authorization is required). This is a
 * to-do, not a failure: the UI prompts for authentication instead of showing
 * a failed validation.
 */
function serverNeedsOAuthSignIn(server: Pick<RuntimeMcpServer, "auth" | "authMode">): boolean {
  return (
    server.auth?.type === "oauth" &&
    (server.authMode === "missing" ||
      server.authMode === "oauth_pending" ||
      server.authMode === "error")
  );
}

type ConnectionKind = "remote" | "local";

const CONNECTION_KIND_OPTIONS: Array<{
  value: ConnectionKind;
  label: string;
  description: string;
}> = [
  {
    value: "remote",
    label: "Remote server",
    description: "Connect to a hosted service by URL",
  },
  {
    value: "local",
    label: "Local command",
    description: "Run a connector on this computer (advanced)",
  },
];

const LOCATION_OPTIONS: Array<{
  value: EditableMcpSource;
  label: string;
  description: string;
}> = [
  {
    value: "user",
    label: "All projects",
    description: "Available in every project and chat on this computer.",
  },
  {
    value: "workspace",
    label: "Only this project",
    description: "Stored with this project and available only here.",
  },
];

export function McpServersPage({ filterQuery = "" }: { filterQuery?: string } = {}) {
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

  // Project workspace, when one is unambiguously in scope. Custom connectors
  // must stay manageable even when only one-off chat workspaces exist, so the
  // page falls back to any workspace with a live control connection.
  const projectWorkspace = useMemo(() => {
    const workspaceId = resolveProjectWorkspaceId(workspaces, selectedWorkspaceId);
    return workspaceId ? (workspaces.find((entry) => entry.id === workspaceId) ?? null) : null;
  }, [workspaces, selectedWorkspaceId]);
  const workspace = useMemo(() => {
    const workspaceId = resolveManagementWorkspaceId(workspaces, selectedWorkspaceId);
    return workspaceId ? (workspaces.find((entry) => entry.id === workspaceId) ?? null) : null;
  }, [workspaces, selectedWorkspaceId]);
  const canChooseLocation = projectWorkspace !== null;

  const runtime = workspace ? workspaceRuntimeById[workspace.id] : null;
  const operationsByKey = useAppStore((s) => s.operationsByKey);
  const saveOperation = workspace
    ? operationsByKey[operationKey("mcp", "save", workspace.id)]
    : undefined;

  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [draft, setDraft] = useState<DraftState>(defaultDraftState);
  const [createLocation, setCreateLocation] = useState<EditableMcpSource>("user");
  const [oauthCodeByName, setOauthCodeByName] = useState<Record<string, string>>({});
  const [oauthCodeEntryOpenByName, setOauthCodeEntryOpenByName] = useState<Record<string, boolean>>(
    {},
  );
  const [oauthMenuOpenKey, setOauthMenuOpenKey] = useState<string | null>(null);
  const [apiKeyByName, setApiKeyByName] = useState<Record<string, string>>({});
  const [expandedServers, setExpandedServers] = useState<Record<string, boolean>>({});
  const [validationServerKeyByName, setValidationServerKeyByName] = useState<
    Record<string, string>
  >({});
  const [editorAdvancedOpen, setEditorAdvancedOpen] = useState(false);
  const [configFilesOpen, setConfigFilesOpen] = useState(false);
  const autoValidateSchedulerRef = useRef(
    createMcpAutoValidateScheduler(
      (workspaceId: string, name: string, source: EditableMcpSource) => {
        void validateWorkspaceMcpServer(workspaceId, name, source);
      },
    ),
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
    setValidationServerKeyByName({});
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
  const normalizedFilter = filterQuery.trim().toLowerCase();
  const visibleServers = useMemo(
    () =>
      normalizedFilter
        ? servers.filter((server) => server.name.toLowerCase().includes(normalizedFilter))
        : servers,
    [servers, normalizedFilter],
  );
  const files = runtime?.mcpFiles ?? [];
  const warnings = runtime?.mcpWarnings ?? [];
  const validationByName = runtime?.mcpValidationByName ?? {};
  const validationByServerKey = useMemo(() => {
    const serversByName = new Map<string, RuntimeMcpServer[]>();
    for (const server of servers) {
      serversByName.set(server.name, [...(serversByName.get(server.name) ?? []), server]);
    }

    const next: typeof validationByName = {};
    for (const [name, validation] of Object.entries(validationByName)) {
      const matchingServers = serversByName.get(name) ?? [];
      if (matchingServers.length === 1) {
        next[serverIdentityKey(matchingServers[0])] = validation;
        continue;
      }
      const serverKey = validationServerKeyByName[name];
      if (serverKey && matchingServers.some((server) => serverIdentityKey(server) === serverKey)) {
        next[serverKey] = validation;
      }
    }
    return next;
  }, [servers, validationByName, validationServerKeyByName]);

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
    setCreateLocation("user");
    setEditorAdvancedOpen(false);
  };

  const openEditEditor = (server: MCPServerConfig, source: EditableMcpSource) => {
    clearAutoValidateTimer();
    setEditorState({ mode: "edit", name: server.name, source });
    setDraft(draftFromServer(server));
    setEditorAdvancedOpen(false);
  };

  const toggleExpand = (key: string) => {
    setExpandedServers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const validateServer = (workspaceId: string, server: RuntimeMcpServer) => {
    setValidationServerKeyByName((prev) => ({
      ...prev,
      [server.name]: serverIdentityKey(server),
    }));
    const pluginTarget = pluginTargetForServer(server);
    if (pluginTarget) {
      void validateWorkspaceMcpServer(workspaceId, server.name, server.source, pluginTarget);
      return;
    }
    void validateWorkspaceMcpServer(workspaceId, server.name, server.source);
  };

  const connectionKind: ConnectionKind = draft.transportType === "stdio" ? "local" : "remote";

  const setConnectionKind = (kind: ConnectionKind) => {
    setDraft((prev) => ({
      ...prev,
      transportType: kind === "local" ? "stdio" : "http",
    }));
  };

  const submitDraft = async () => {
    if (!workspace || saveOperation?.status === "pending") return;
    const next = buildServerFromDraft(draft);
    if (!next) return;
    const workspaceId = workspace.id;
    const previousName = getPreviousNameForUpsert(editorState);
    const source: EditableMcpSource =
      editorState?.mode === "edit"
        ? editorState.source
        : canChooseLocation
          ? createLocation
          : "user";
    const result = await upsertWorkspaceMcpServer(workspaceId, next, previousName, source);
    if (!result.ok) return;
    setValidationServerKeyByName((prev) => ({
      ...prev,
      [next.name]: serverIdentityKey({ name: next.name, source }),
    }));
    autoValidateSchedulerRef.current.schedule(workspaceId, next.name, source);
    resetDraft({ clearAutoValidate: false });
  };

  const [parent] = useAutoAnimate();

  return (
    <SettingsSection
      title="Connectors"
      description="Connect Cowork to external tools and services using MCP."
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
            Add connector
          </Button>
        ) : undefined
      }
    >
      {workspace ? (
        <Dialog
          open={editorState !== null}
          onOpenChange={(open) => {
            if (!open && saveOperation?.status === "pending") return;
            if (!open && editorState === null) return;
            if (!open) resetDraft();
          }}
        >
          {editorState !== null ? (
            <DialogContent
              forceMount
              aria-busy={saveOperation?.status === "pending"}
              className="max-w-2xl max-h-[85vh] overflow-y-auto"
            >
              <DialogHeader>
                <DialogTitle>{getMcpEditorTitle(editorState)}</DialogTitle>
              </DialogHeader>
              <fieldset
                disabled={saveOperation?.status === "pending"}
                className="flex flex-col gap-5 py-2"
              >
                <Field>
                  <FieldLabel htmlFor="mcp-connector-name">Name</FieldLabel>
                  <Input
                    id="mcp-connector-name"
                    placeholder="e.g. Linear, Notion, GitHub"
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, name: event.target.value }))
                    }
                  />
                </Field>

                <Field>
                  <FieldLabel>Connection type</FieldLabel>
                  <RadioGroup
                    value={connectionKind}
                    onValueChange={(value) =>
                      setConnectionKind(value === "local" ? "local" : "remote")
                    }
                    className="grid gap-2 sm:grid-cols-2"
                  >
                    {CONNECTION_KIND_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        htmlFor={`mcp-connection-${option.value}`}
                        className={cn(
                          "flex cursor-pointer items-start gap-3 p-3 transition-colors hover:bg-muted/40",
                          connectionKind === option.value && "bg-primary/10",
                        )}
                      >
                        <RadioGroupItem
                          id={`mcp-connection-${option.value}`}
                          value={option.value}
                          aria-label={option.label}
                          className="mt-0.5"
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-sm font-medium text-foreground">
                            {option.label}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                </Field>

                {connectionKind === "remote" ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="mcp-server-url">Server URL</FieldLabel>
                      <Input
                        id="mcp-server-url"
                        placeholder="https://example.com/mcp"
                        value={draft.url}
                        onChange={(event) =>
                          setDraft((prev) => ({ ...prev, url: event.target.value }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="mcp-auth-type">Authentication</FieldLabel>
                      <Select
                        value={draft.authType}
                        onValueChange={(value) =>
                          setDraft((prev) => ({
                            ...prev,
                            authType: value as DraftState["authType"],
                          }))
                        }
                      >
                        <SelectTrigger id="mcp-auth-type" aria-label="Authentication">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="api_key">API key</SelectItem>
                          <SelectItem value="oauth">OAuth — sign in with your account</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </>
                ) : (
                  <>
                    <Field>
                      <FieldLabel htmlFor="mcp-command">Command</FieldLabel>
                      <Input
                        id="mcp-command"
                        placeholder="e.g. npx my-connector"
                        value={draft.command}
                        onChange={(event) =>
                          setDraft((prev) => ({ ...prev, command: event.target.value }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="mcp-args">Arguments (optional)</FieldLabel>
                      <Input
                        id="mcp-args"
                        placeholder="--flag value"
                        value={draft.args}
                        onChange={(event) =>
                          setDraft((prev) => ({ ...prev, args: event.target.value }))
                        }
                      />
                    </Field>
                  </>
                )}

                {isCreating && canChooseLocation ? (
                  <Field>
                    <FieldLabel>Where should this be available?</FieldLabel>
                    <RadioGroup
                      value={createLocation}
                      onValueChange={(value) =>
                        setCreateLocation(value === "workspace" ? "workspace" : "user")
                      }
                      className="gap-2"
                    >
                      {LOCATION_OPTIONS.map((option) => (
                        <label
                          key={option.value}
                          htmlFor={`mcp-location-${option.value}`}
                          className={cn(
                            "flex cursor-pointer items-start gap-3 p-3 transition-colors hover:bg-muted/40",
                            createLocation === option.value && "bg-primary/10",
                          )}
                        >
                          <RadioGroupItem
                            id={`mcp-location-${option.value}`}
                            value={option.value}
                            aria-label={option.label}
                            className="mt-0.5"
                          />
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-sm font-medium text-foreground">
                              {option.label}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </RadioGroup>
                  </Field>
                ) : null}

                <Collapsible open={editorAdvancedOpen} onOpenChange={setEditorAdvancedOpen}>
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="-ml-2 h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRightIcon
                        className={cn(
                          "size-4 transition-transform",
                          editorAdvancedOpen && "rotate-90",
                        )}
                      />
                      Advanced
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="flex flex-col gap-4 pt-3">
                      {connectionKind === "remote" ? (
                        <>
                          <Field>
                            <FieldLabel htmlFor="mcp-headers">
                              HTTP headers (one KEY=VALUE per line, optional)
                            </FieldLabel>
                            <Textarea
                              id="mcp-headers"
                              placeholder={"x-tenant=team-a\nauthorization=Bearer token"}
                              aria-label="HTTP headers"
                              className="min-h-16 font-mono text-xs"
                              value={draft.headers}
                              onChange={(event) =>
                                setDraft((prev) => ({ ...prev, headers: event.target.value }))
                              }
                            />
                          </Field>
                          <div className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2">
                            <span className="flex flex-col gap-0.5">
                              <span className="text-sm">Use legacy SSE transport</span>
                              <span className="text-xs text-muted-foreground">
                                Only for older servers that don't support streamable HTTP.
                              </span>
                            </span>
                            <Switch
                              aria-label="Use legacy SSE transport"
                              checked={draft.transportType === "sse"}
                              onCheckedChange={(checked) =>
                                setDraft((prev) => ({
                                  ...prev,
                                  transportType: toBool(checked) ? "sse" : "http",
                                }))
                              }
                            />
                          </div>
                        </>
                      ) : (
                        <>
                          <Field>
                            <FieldLabel htmlFor="mcp-env">
                              Environment variables (one KEY=VALUE per line, optional)
                            </FieldLabel>
                            <Textarea
                              id="mcp-env"
                              placeholder={"API_TOKEN=secret\nDEBUG=1"}
                              aria-label="Environment variables"
                              className="min-h-16 font-mono text-xs"
                              value={draft.env}
                              onChange={(event) =>
                                setDraft((prev) => ({ ...prev, env: event.target.value }))
                              }
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="mcp-cwd">Working directory (optional)</FieldLabel>
                            <Input
                              id="mcp-cwd"
                              placeholder="/path/to/directory"
                              value={draft.cwd}
                              onChange={(event) =>
                                setDraft((prev) => ({ ...prev, cwd: event.target.value }))
                              }
                            />
                          </Field>
                        </>
                      )}

                      {connectionKind === "remote" && draft.authType === "api_key" ? (
                        <div className="grid gap-3 md:grid-cols-3">
                          <Input
                            placeholder="Header name (optional)"
                            aria-label="API key header name"
                            value={draft.headerName}
                            onChange={(event) =>
                              setDraft((prev) => ({ ...prev, headerName: event.target.value }))
                            }
                          />
                          <Input
                            placeholder="Prefix (optional)"
                            aria-label="API key prefix"
                            value={draft.prefix}
                            onChange={(event) =>
                              setDraft((prev) => ({ ...prev, prefix: event.target.value }))
                            }
                          />
                          <Input
                            placeholder="Key id (optional)"
                            aria-label="API key id"
                            value={draft.keyId}
                            onChange={(event) =>
                              setDraft((prev) => ({ ...prev, keyId: event.target.value }))
                            }
                          />
                        </div>
                      ) : null}

                      {connectionKind === "remote" && draft.authType === "oauth" ? (
                        <div className="grid gap-3 md:grid-cols-3">
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
                              <SelectItem value="auto">Automatic</SelectItem>
                              <SelectItem value="code">Paste a code</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            placeholder="Scope (optional)"
                            aria-label="OAuth scope"
                            value={draft.scope}
                            onChange={(event) =>
                              setDraft((prev) => ({ ...prev, scope: event.target.value }))
                            }
                          />
                          <Input
                            placeholder="Resource (optional)"
                            aria-label="OAuth resource"
                            value={draft.resource}
                            onChange={(event) =>
                              setDraft((prev) => ({ ...prev, resource: event.target.value }))
                            }
                          />
                        </div>
                      ) : null}

                      <div className="grid gap-3 md:grid-cols-2">
                        <Input
                          placeholder="Icon URL (optional)"
                          aria-label="Icon URL"
                          value={draft.icon}
                          onChange={(event) =>
                            setDraft((prev) => ({ ...prev, icon: event.target.value }))
                          }
                        />
                        <Input
                          placeholder="Retries (optional)"
                          aria-label="Retries"
                          value={draft.retries}
                          onChange={(event) =>
                            setDraft((prev) => ({ ...prev, retries: event.target.value }))
                          }
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2">
                        <span className="flex flex-col gap-0.5">
                          <span className="text-sm">Required</span>
                          <span className="text-xs text-muted-foreground">
                            Treat sessions as broken when this connector fails to start.
                          </span>
                        </span>
                        <Switch
                          aria-label="Required"
                          checked={draft.required}
                          onCheckedChange={(checked) =>
                            setDraft((prev) => ({ ...prev, required: toBool(checked) }))
                          }
                        />
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                <OperationFeedback operation={saveOperation} />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => void submitDraft()}>
                    {saveOperation?.status === "pending"
                      ? "Saving…"
                      : getMcpEditorSubmitLabel(editorState)}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => resetDraft()}>
                    Cancel
                  </Button>
                </div>
              </fieldset>
            </DialogContent>
          ) : null}
        </Dialog>
      ) : null}

      <div ref={parent}>
        {servers.length === 0 ? (
          <div className="p-4">
            <SettingsEmptyState
              icon={<ServerIcon />}
              title="No connectors yet"
              description="Connect Cowork to tools like Linear, Notion, or GitHub by adding a connector."
              action={
                workspace ? (
                  <Button type="button" variant="outline" size="sm" onClick={openCreateEditor}>
                    <PlusIcon data-icon="inline-start" />
                    Add connector
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : visibleServers.length === 0 ? (
          <NoMatchesState query={filterQuery.trim()} />
        ) : null}
        {visibleServers.map((server) => {
          const serverKey = serverIdentityKey(server);
          const draftKey = workspace ? mcpCredentialDraftKey(workspace.id, server) : serverKey;
          const enabledOperation = workspace
            ? operationsByKey[
                operationKey(
                  "mcp",
                  "enabled",
                  workspace.id,
                  server.source,
                  server.pluginScope,
                  server.pluginId,
                  server.name,
                )
              ]
            : undefined;
          const validation = validationByServerKey[serverKey];
          const editSource = editableSource(server.source);
          const apiKeyDraft = apiKeyByName[draftKey] ?? "";
          const oauthCode = oauthCodeByName[draftKey] ?? "";
          const isExpanded = expandedServers[serverKey] ?? false;
          const serverEnabled = server.enabled !== false;
          const canToggle =
            server.source !== "system" &&
            (server.source !== "plugin" ||
              (Boolean(server.pluginId) && Boolean(server.pluginScope)));
          const validationTools =
            validation?.ok && Array.isArray(validation.tools) ? validation.tools : [];
          const availableToolCount = validation?.ok
            ? (validation.toolCount ?? validationTools.length)
            : 0;
          const needsOAuthSignIn = serverNeedsOAuthSignIn(server);
          const pluginTarget = pluginTargetForServer(server);
          const authorizeServer = () => {
            if (!workspace) return;
            if (pluginTarget) {
              void authorizeWorkspaceMcpServerAuth(
                workspace.id,
                server.name,
                server.source,
                pluginTarget,
              );
              return;
            }
            void authorizeWorkspaceMcpServerAuth(workspace.id, server.name, server.source);
          };
          const callbackServer = () => {
            if (!workspace) return;
            const code = oauthCode.trim() ? oauthCode : undefined;
            if (pluginTarget) {
              void callbackWorkspaceMcpServerAuth(
                workspace.id,
                server.name,
                code,
                server.source,
                pluginTarget,
              );
              return;
            }
            void callbackWorkspaceMcpServerAuth(workspace.id, server.name, code, server.source);
          };
          const saveApiKey = () => {
            if (!workspace) return;
            if (pluginTarget) {
              void setWorkspaceMcpServerApiKey(
                workspace.id,
                server.name,
                apiKeyDraft.trim(),
                server.source,
                pluginTarget,
              );
              return;
            }
            void setWorkspaceMcpServerApiKey(
              workspace.id,
              server.name,
              apiKeyDraft.trim(),
              server.source,
            );
          };

          return (
            <div
              key={serverKey}
              className={cn(
                "border-b border-border/45 last:border-b-0",
                isExpanded && "bg-card/40",
              )}
            >
              <div className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-card/60">
                <div className="flex min-w-0 flex-1 items-center gap-3">
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
                    <Badge variant="secondary" className="h-5 text-xs">
                      {sourceLabel(server.source)}
                    </Badge>
                    {!serverEnabled ? (
                      <Badge variant="secondary" className="h-5 text-xs">
                        Disabled
                      </Badge>
                    ) : null}
                    {validation?.ok ? (
                      <CheckCircle2Icon className="size-4 shrink-0 text-success" />
                    ) : validation && !validation.ok && !needsOAuthSignIn ? (
                      <XCircleIcon className="size-4 shrink-0 text-destructive" />
                    ) : null}
                  </button>
                  {needsOAuthSignIn ? (
                    // Matches the SettingsStatusPill warning tone, as a real
                    // button so sign-in is one click from the collapsed row.
                    <button
                      type="button"
                      aria-label={`Authenticate ${server.name}`}
                      className="inline-flex h-6 shrink-0 items-center rounded-md border border-warning/35 bg-warning/12 px-2 text-xs font-medium text-warning-foreground shadow-none outline-none transition-colors hover:bg-warning/20 focus-visible:ring-[3px] focus-visible:ring-ring"
                      onClick={(event) => {
                        event.stopPropagation();
                        authorizeServer();
                      }}
                    >
                      Authenticate
                    </button>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {serverEnabled ? "Enabled" : "Disabled"}
                    </span>
                    <Switch
                      checked={serverEnabled}
                      disabled={!canToggle || enabledOperation?.status === "pending"}
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
                  {editSource ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${server.name}`}
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        openEditEditor(server, editSource);
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        openEditEditor(server, editSource);
                      }}
                    >
                      <SettingsIcon className="size-4" />
                    </Button>
                  ) : null}
                </div>
              </div>

              {isExpanded && (
                <div className="flex flex-col gap-4 px-11 pb-4 text-xs">
                  <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">
                      Connection
                    </span>
                    <span className="inline-block w-fit rounded bg-muted/30 px-2 py-1 font-mono text-xs">
                      {formatTransport(server)}
                    </span>
                  </div>

                  <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">
                      Authentication
                    </span>
                    <span className="text-[13px] text-foreground">
                      {authModeLabel(server.authMode)}
                    </span>
                  </div>

                  {server.authMessage && (
                    <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                      <span className="text-xs uppercase tracking-wider text-muted-foreground">
                        Status
                      </span>
                      <span className="text-[13px] text-foreground">{server.authMessage}</span>
                    </div>
                  )}

                  {validation && (
                    <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                      <span className="text-xs uppercase tracking-wider text-muted-foreground">
                        Last check
                      </span>
                      {!validation.ok && needsOAuthSignIn ? (
                        <span className="text-[13px] text-muted-foreground">
                          Waiting for sign-in
                        </span>
                      ) : (
                        <span className="text-[13px] text-foreground">
                          {validation.ok ? "Passed" : "Failed"}
                          {typeof validation.latencyMs === "number"
                            ? ` • ${validation.latencyMs}ms`
                            : ""}
                        </span>
                      )}
                    </div>
                  )}

                  {validation?.ok && availableToolCount > 0 && (
                    <div className="mt-2 grid grid-cols-[120px_1fr] items-start gap-2">
                      <span className="mt-1 text-xs uppercase tracking-wider text-muted-foreground">
                        Tools
                      </span>
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">
                          {availableToolCount === 1
                            ? "1 tool available"
                            : `${availableToolCount} tools available`}
                        </span>
                        {validationTools.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {validationTools.map((t) => (
                              <div
                                key={t.name}
                                className="group relative flex cursor-default items-center rounded-sm border border-border/50 bg-muted/40 px-2 py-0.5 font-mono text-xs text-foreground"
                                title={t.description || t.name}
                              >
                                {displayToolName(t.name, server.name)}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-7 border-transparent bg-muted/40 text-xs text-foreground shadow-none hover:bg-muted/60"
                      onClick={() => workspace && validateServer(workspace.id, server)}
                    >
                      Test connection
                    </Button>
                    {editSource ? (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="h-7 border-transparent bg-destructive/10 text-xs text-destructive shadow-none hover:bg-destructive/20 hover:text-destructive"
                        onClick={async () => {
                          if (!workspace) return;
                          const confirmed = await confirmAction({
                            title: "Remove connector",
                            message: `Remove "${server.name}"?`,
                            detail: "Cowork will no longer be able to use this connector.",
                            confirmLabel: "Remove",
                            cancelLabel: "Cancel",
                            kind: "warning",
                            defaultAction: "cancel",
                          });
                          if (confirmed) {
                            void deleteWorkspaceMcpServer(workspace.id, server.name, editSource);
                          }
                        }}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>

                  {server.auth?.type === "oauth" ? (
                    <div className="mt-2 flex flex-col gap-2 border-t border-border/50 pt-3">
                      <div className="flex items-center gap-2">
                        <Button type="button" size="sm" onClick={authorizeServer}>
                          Sign in
                        </Button>
                        <DropdownMenu
                          open={oauthMenuOpenKey === draftKey}
                          onOpenChange={(open) => setOauthMenuOpenKey(open ? draftKey : null)}
                        >
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`More sign-in options for ${server.name}`}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <MoreHorizontalIcon className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          {/* Conditional render + forceMount matches the editor
                              Dialog pattern so the menu mounts reliably. */}
                          {oauthMenuOpenKey === draftKey ? (
                            <DropdownMenuContent forceMount align="start">
                              <DropdownMenuItem
                                onSelect={() =>
                                  setOauthCodeEntryOpenByName((prev) => ({
                                    ...prev,
                                    [draftKey]: true,
                                  }))
                                }
                              >
                                Paste sign-in code…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          ) : null}
                        </DropdownMenu>
                      </div>
                      {oauthCodeEntryOpenByName[draftKey] ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            className="h-7 max-w-64 text-xs"
                            placeholder="Paste sign-in code (optional)"
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
                            onClick={callbackServer}
                          >
                            Continue
                          </Button>
                        </div>
                      ) : null}
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
                        onClick={saveApiKey}
                      >
                        Save key
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Collapsible open={configFilesOpen} onOpenChange={setConfigFilesOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start gap-2 rounded-none px-4 py-2.5 text-sm font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            <WrenchIcon className="size-4" />
            <span>Advanced: config files</span>
            <ChevronDownIcon
              className={cn("ml-auto size-4 transition-transform", configFilesOpen && "rotate-180")}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-2 px-4 pb-4 text-xs">
            {files.map((file) => (
              <div key={file.path} className="rounded-lg bg-foreground/[0.04] px-3 py-2">
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
