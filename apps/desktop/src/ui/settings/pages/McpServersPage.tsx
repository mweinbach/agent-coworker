import {
  SettingsIcon,
  CheckCircle2Icon,
  XCircleIcon,
  PlusIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  WrenchIcon,
} from "lucide-react";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";

import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { cn } from "../../../lib/utils";
import {
  buildServerFromDraft,
  defaultDraftState,
  draftFromServer,
  formatTransport,
  sourceLabel,
  toBool,
  type DraftState,
} from "./mcpServerDraft";
import {
  createMcpAutoValidateScheduler,
  getEditingServerName,
  getMcpEditorSubmitLabel,
  getMcpEditorTitle,
  getPreviousNameForUpsert,
  type EditorState,
} from "./mcpServerEditorState";

function credentialDraftKey(workspaceId: string, serverName: string): string {
  return `${workspaceId}::${serverName}`;
}

export function McpServersPage() {
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceRuntimeById = useAppStore((s) => s.workspaceRuntimeById);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);

  const requestWorkspaceMcpServers = useAppStore((s) => s.requestWorkspaceMcpServers);
  const upsertWorkspaceMcpServer = useAppStore((s) => s.upsertWorkspaceMcpServer);
  const deleteWorkspaceMcpServer = useAppStore((s) => s.deleteWorkspaceMcpServer);
  const validateWorkspaceMcpServer = useAppStore((s) => s.validateWorkspaceMcpServer);
  const authorizeWorkspaceMcpServerAuth = useAppStore((s) => s.authorizeWorkspaceMcpServerAuth);
  const callbackWorkspaceMcpServerAuth = useAppStore((s) => s.callbackWorkspaceMcpServerAuth);
  const setWorkspaceMcpServerApiKey = useAppStore((s) => s.setWorkspaceMcpServerApiKey);
  const migrateWorkspaceMcpLegacy = useAppStore((s) => s.migrateWorkspaceMcpLegacy);

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

  const clearAutoValidateTimer = () => {
    autoValidateSchedulerRef.current.cancel();
  };

  const editingName = getEditingServerName(editorState);
  const isCreating = editorState?.mode === "create";

  useEffect(() => {
    if (!workspace) return;
    clearAutoValidateTimer();
    setEditorState(null);
    setDraft(defaultDraftState());
    void requestWorkspaceMcpServers(workspace.id);
  }, [workspace?.id]);

  useEffect(() => clearAutoValidateTimer, []);

  const servers = runtime?.mcpServers ?? [];
  const files = runtime?.mcpFiles ?? [];
  const warnings = runtime?.mcpWarnings ?? [];
  const validationByName = runtime?.mcpValidationByName ?? {};
  const hasLegacyWorkspace = runtime?.mcpLegacy?.workspace.exists ?? false;
  const hasLegacyUser = runtime?.mcpLegacy?.user.exists ?? false;

  const resetDraft = ({ clearAutoValidate = true }: { clearAutoValidate?: boolean } = {}) => {
    if (clearAutoValidate) clearAutoValidateTimer();
    setEditorState(null);
    setDraft(defaultDraftState());
  };

  const toggleExpand = (name: string) => {
    setExpandedServers(prev => ({ ...prev, [name]: !prev[name] }));
  };

  const [parent] = useAutoAnimate();

  return (
    <div className="space-y-5" ref={parent}>
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">MCP servers</h1>
        <p className="text-sm text-muted-foreground">Connect external tools and services Cowork can use in this workspace.</p>
      </div>



      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Custom servers</h2>
        {workspace ? (
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => {
            if (isCreating) {
              resetDraft();
              return;
            }
            clearAutoValidateTimer();
            setEditorState({ mode: "create" });
            setDraft(defaultDraftState());
          }}>
            <PlusIcon className="w-4 h-4 mr-1" />
            Add server
          </Button>
        ) : null}
      </div>

      {workspace && (hasLegacyWorkspace || hasLegacyUser) ? (
        <Card className="border-warning/35 bg-warning/[0.08]">
          <CardHeader>
            <CardTitle>Legacy MCP configs found</CardTitle>
            <CardDescription>
              `.agent/mcp-servers.json` files are visible as fallback. Migrate to `.cowork` to make them first-class.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {hasLegacyWorkspace ? (
              <Button type="button" variant="outline" onClick={() => void migrateWorkspaceMcpLegacy(workspace.id, "workspace")}>
                Migrate workspace legacy
              </Button>
            ) : null}
            {hasLegacyUser ? (
              <Button type="button" variant="outline" onClick={() => void migrateWorkspaceMcpLegacy(workspace.id, "user")}>
                Migrate user legacy
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {workspace ? (
        <Dialog open={editorState !== null} onOpenChange={(open) => { if (!open) resetDraft(); }}>
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
                onValueChange={(value) => setDraft((prev) => ({ ...prev, transportType: value as DraftState["transportType"] }))}
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
              <div className="grid gap-3 md:grid-cols-3">
                <Input
                  placeholder="Command"
                  value={draft.command}
                  onChange={(event) => setDraft((prev) => ({ ...prev, command: event.target.value }))}
                />
                <Input
                  placeholder="Args (shell-style, optional)"
                  value={draft.args}
                  onChange={(event) => setDraft((prev) => ({ ...prev, args: event.target.value }))}
                />
                <Input
                  placeholder="CWD (optional)"
                  value={draft.cwd}
                  onChange={(event) => setDraft((prev) => ({ ...prev, cwd: event.target.value }))}
                />
              </div>
            ) : (
              <Input
                placeholder="Server URL"
                value={draft.url}
                onChange={(event) => setDraft((prev) => ({ ...prev, url: event.target.value }))}
              />
            )}

            <div className="grid gap-3 md:grid-cols-2">
              <Input
                placeholder="Retries (optional)"
                value={draft.retries}
                onChange={(event) => setDraft((prev) => ({ ...prev, retries: event.target.value }))}
              />
              <div className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2">
                <span className="text-sm">Required server</span>
                <Checkbox
                  checked={draft.required}
                  onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, required: toBool(checked) }))}
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <Select
                value={draft.authType}
                onValueChange={(value) => setDraft((prev) => ({ ...prev, authType: value as DraftState["authType"] }))}
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
                  onValueChange={(value) => setDraft((prev) => ({ ...prev, oauthMode: value as "auto" | "code" }))}
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
                  onChange={(event) => setDraft((prev) => ({ ...prev, headerName: event.target.value }))}
                />
                <Input
                  placeholder="Prefix (optional)"
                  value={draft.prefix}
                  onChange={(event) => setDraft((prev) => ({ ...prev, prefix: event.target.value }))}
                />
                <Input
                  placeholder="Key id (optional)"
                  value={draft.keyId}
                  onChange={(event) => setDraft((prev) => ({ ...prev, keyId: event.target.value }))}
                />
              </div>
            ) : null}

            {draft.authType === "oauth" ? (
              <div className="grid gap-3 md:grid-cols-2">
                <Input
                  placeholder="Scope (optional)"
                  value={draft.scope}
                  onChange={(event) => setDraft((prev) => ({ ...prev, scope: event.target.value }))}
                />
                <Input
                  placeholder="Resource (optional)"
                  value={draft.resource}
                  onChange={(event) => setDraft((prev) => ({ ...prev, resource: event.target.value }))}
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
                  void upsertWorkspaceMcpServer(workspaceId, next, previousName);
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

      <div className="rounded-xl border border-border/70 overflow-hidden bg-background/50" ref={parent}>
          {servers.length === 0 ? <div className="text-sm text-muted-foreground p-4 text-center">No custom servers configured.</div> : null}
          {servers.map((server) => {
            const draftKey = workspace ? credentialDraftKey(workspace.id, server.name) : server.name;
            const validation = validationByName[server.name];
            const canEdit = server.source === "workspace";
            const apiKeyDraft = apiKeyByName[draftKey] ?? "";
            const oauthCode = oauthCodeByName[draftKey] ?? "";
            const isExpanded = expandedServers[server.name] ?? false;

            return (
              <div key={server.name} className={cn("border-b border-border/70 last:border-b-0", isExpanded && "bg-card/40")}>
                <div className="flex items-center justify-between p-4 cursor-pointer hover:bg-card/60 transition-colors" onClick={() => toggleExpand(server.name)}>
                  <div className="flex items-center gap-3">
                    {isExpanded ? <ChevronDownIcon className="w-4 h-4 text-muted-foreground" /> : <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />}
                    <span className="font-medium text-foreground text-sm">{server.name}</span>
                    {!canEdit && <Badge variant="secondary" className="text-[10px] uppercase h-5">{sourceLabel(server.source)}</Badge>}
                    {validation && validation.ok ? <CheckCircle2Icon className="w-4 h-4 text-success" /> : validation && !validation.ok ? <XCircleIcon className="w-4 h-4 text-destructive" /> : null}
                  </div>
                  
                  <div className="flex items-center gap-3" onClick={e => e.stopPropagation()}>
                    {canEdit && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => {
                        if (!isExpanded) toggleExpand(server.name);
                        clearAutoValidateTimer();
                        setEditorState({ mode: "edit", name: server.name });
                        setDraft(draftFromServer(server));
                      }}>
                        <SettingsIcon className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-10 pb-4 text-xs space-y-4">
                    <div className="grid grid-cols-[120px_1fr] gap-2 items-center">
                      <span className="text-muted-foreground uppercase tracking-wider text-[10px]">Command</span>
                      <span className="font-mono bg-muted/30 px-2 py-1 rounded inline-block w-fit text-[11px]">{formatTransport(server)}</span>
                    </div>
                    
                    <div className="grid grid-cols-[120px_1fr] gap-2 items-center">
                      <span className="text-muted-foreground uppercase tracking-wider text-[10px]">Auth Mode</span>
                      <span className="text-foreground text-[13px]">{server.authMode}</span>
                    </div>
                    
                    {server.authMessage && (
                      <div className="grid grid-cols-[120px_1fr] gap-2 items-center">
                        <span className="text-muted-foreground uppercase tracking-wider text-[10px]">Auth Status</span>
                        <span className="text-foreground text-[13px]">{server.authMessage}</span>
                      </div>
                    )}
                    
                    {validation && (
                      <div className="grid grid-cols-[120px_1fr] gap-2 items-center">
                        <span className="text-muted-foreground uppercase tracking-wider text-[10px]">Last Check</span>
                        <span className="text-foreground text-[13px]">
                          {validation.ok ? "Passed" : "Failed"} ({validation.mode})
                          {typeof validation.toolCount === "number" ? ` • ${validation.toolCount} tools` : ""}
                          {typeof validation.latencyMs === "number" ? ` • ${validation.latencyMs}ms` : ""}
                        </span>
                      </div>
                    )}

                    {validation?.ok && Array.isArray(validation.tools) && validation.tools.length > 0 && (
                      <div className="grid grid-cols-[120px_1fr] gap-2 items-start mt-2">
                        <span className="text-muted-foreground uppercase tracking-wider text-[10px] mt-1">Available Tools</span>
                        <div className="flex flex-wrap gap-1.5">
                          {validation.tools.map((t) => (
                            <div key={t.name} className="px-2 py-0.5 bg-muted/40 border border-border/50 rounded-sm text-xs font-mono text-foreground flex items-center group relative cursor-default" title={t.description || t.name}>
                              {t.name}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center gap-2 pt-2">
                      <Button type="button" variant="secondary" size="sm" className="h-7 text-xs bg-muted/40 hover:bg-muted/60 text-foreground shadow-none border-transparent" onClick={() => workspace && void validateWorkspaceMcpServer(workspace.id, server.name)}>
                        Validate Connection
                      </Button>
                      {canEdit && (
                        <Button type="button" variant="destructive" size="sm" className="h-7 text-xs bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive shadow-none border-transparent" onClick={() => workspace && void deleteWorkspaceMcpServer(workspace.id, server.name)}>
                          Delete Server
                        </Button>
                      )}
                    </div>

                    {server.auth?.type === "oauth" ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 pt-2 border-t border-border/50">
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => workspace && void authorizeWorkspaceMcpServerAuth(workspace.id, server.name)}>
                          Sign in
                        </Button>
                        <Input
                          className="max-w-64 h-7 text-xs"
                          placeholder="Paste OAuth code (optional)"
                          value={oauthCode}
                          onChange={(event) => setOauthCodeByName((prev) => ({ ...prev, [draftKey]: event.target.value }))}
                        />
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => workspace && void callbackWorkspaceMcpServerAuth(workspace.id, server.name, oauthCode.trim() ? oauthCode : undefined)}>
                          Continue
                        </Button>
                      </div>
                    ) : null}

                    {server.auth?.type === "api_key" ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 pt-2 border-t border-border/50">
                        <Input
                          className="max-w-64 h-7 text-xs"
                          placeholder="Paste API key"
                          value={apiKeyDraft}
                          onChange={(event) => setApiKeyByName((prev) => ({ ...prev, [draftKey]: event.target.value }))}
                        />
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => workspace && void setWorkspaceMcpServerApiKey(workspace.id, server.name, apiKeyDraft.trim())}>
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
            className="h-auto w-full justify-start gap-2 rounded-lg px-1 py-1.5 text-sm font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            <WrenchIcon className="size-4" />
            <span>Advanced</span>
            <ChevronDownIcon className={cn("ml-auto size-4 transition-transform", advancedOpen && "rotate-180")} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-5 pt-2">
          <Card className="border-border/80 bg-card/85">
            <CardHeader>
              <CardTitle>Config files</CardTitle>
              <CardDescription>Layer sources and parse warnings.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {files.map((file) => (
                <div key={file.path} className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                  <div className="font-medium text-foreground">
                    {sourceLabel(file.source)} {file.editable ? "(editable)" : "(read-only)"}
                  </div>
                  <div className="font-mono text-muted-foreground">{file.path}</div>
                  <div className="text-muted-foreground">exists={String(file.exists)}, servers={file.serverCount}</div>
                  {file.parseError ? <div className="text-destructive">parse error: {file.parseError}</div> : null}
                </div>
              ))}
              {warnings.length > 0 ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                  {warnings.join(" | ")}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
