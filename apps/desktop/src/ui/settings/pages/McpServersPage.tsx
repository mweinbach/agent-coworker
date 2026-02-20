import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import type { MCPServerConfig } from "../../../lib/wsProtocol";

type DraftState = {
  name: string;
  transportType: "stdio" | "http" | "sse";
  command: string;
  args: string;
  cwd: string;
  url: string;
  required: boolean;
  retries: string;
  authType: "none" | "api_key" | "oauth";
  headerName: string;
  prefix: string;
  keyId: string;
  scope: string;
  resource: string;
  oauthMode: "auto" | "code";
};

function toBool(checked: boolean | "indeterminate") {
  return checked === true;
}

function parseArgs(value: string): string[] | undefined {
  const split = value
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return split.length > 0 ? split : undefined;
}

function formatTransport(server: MCPServerConfig): string {
  if (server.transport.type === "stdio") {
    const args = server.transport.args?.length ? ` ${server.transport.args.join(" ")}` : "";
    return `stdio: ${server.transport.command}${args}`;
  }
  return `${server.transport.type}: ${server.transport.url}`;
}

function sourceLabel(source: string): string {
  if (source === "workspace") return "workspace";
  if (source === "user") return "user";
  if (source === "system") return "system";
  if (source === "workspace_legacy") return "workspace legacy";
  if (source === "user_legacy") return "user legacy";
  return source;
}

function draftFromServer(server: MCPServerConfig): DraftState {
  const base: DraftState = {
    name: server.name,
    transportType: server.transport.type,
    command: "",
    args: "",
    cwd: "",
    url: "",
    required: server.required === true,
    retries: typeof server.retries === "number" ? String(server.retries) : "",
    authType: server.auth?.type ?? "none",
    headerName: "",
    prefix: "",
    keyId: "",
    scope: "",
    resource: "",
    oauthMode: "auto",
  };

  if (server.transport.type === "stdio") {
    base.command = server.transport.command;
    base.args = server.transport.args?.join(" ") ?? "";
    base.cwd = server.transport.cwd ?? "";
  } else {
    base.url = server.transport.url;
  }

  if (server.auth?.type === "api_key") {
    base.headerName = server.auth.headerName ?? "";
    base.prefix = server.auth.prefix ?? "";
    base.keyId = server.auth.keyId ?? "";
  }

  if (server.auth?.type === "oauth") {
    base.scope = server.auth.scope ?? "";
    base.resource = server.auth.resource ?? "";
    base.oauthMode = server.auth.oauthMode ?? "auto";
  }

  return base;
}

function buildServerFromDraft(draft: DraftState): MCPServerConfig | null {
  const name = draft.name.trim();
  if (!name) return null;

  const transport = (() => {
    if (draft.transportType === "stdio") {
      const command = draft.command.trim();
      if (!command) return null;
      return {
        type: "stdio" as const,
        command,
        ...(parseArgs(draft.args) ? { args: parseArgs(draft.args) } : {}),
        ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
      };
    }

    const url = draft.url.trim();
    if (!url) return null;
    return {
      type: draft.transportType,
      url,
    };
  })();
  if (!transport) return null;

  const retries = Number(draft.retries);
  const auth: MCPServerConfig["auth"] = (() => {
    if (draft.authType === "none") return { type: "none" };
    if (draft.authType === "api_key") {
      return {
        type: "api_key",
        ...(draft.headerName.trim() ? { headerName: draft.headerName.trim() } : {}),
        ...(draft.prefix.trim() ? { prefix: draft.prefix.trim() } : {}),
        ...(draft.keyId.trim() ? { keyId: draft.keyId.trim() } : {}),
      };
    }
    return {
      type: "oauth",
      ...(draft.scope.trim() ? { scope: draft.scope.trim() } : {}),
      ...(draft.resource.trim() ? { resource: draft.resource.trim() } : {}),
      oauthMode: draft.oauthMode,
    };
  })();

  return {
    name,
    transport,
    ...(draft.required ? { required: true } : {}),
    ...(Number.isFinite(retries) ? { retries } : {}),
    ...(auth ? { auth } : {}),
  };
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

  const [editingName, setEditingName] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>({
    name: "",
    transportType: "stdio",
    command: "",
    args: "",
    cwd: "",
    url: "",
    required: false,
    retries: "",
    authType: "none",
    headerName: "",
    prefix: "",
    keyId: "",
    scope: "",
    resource: "",
    oauthMode: "auto",
  });
  const [oauthCodeByName, setOauthCodeByName] = useState<Record<string, string>>({});
  const [apiKeyByName, setApiKeyByName] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!workspace) return;
    void requestWorkspaceMcpServers(workspace.id);
  }, [workspace?.id]);

  const servers = runtime?.mcpServers ?? [];
  const files = runtime?.mcpFiles ?? [];
  const warnings = runtime?.mcpWarnings ?? [];
  const validationByName = runtime?.mcpValidationByName ?? {};
  const hasLegacyWorkspace = runtime?.mcpLegacy?.workspace.exists ?? false;
  const hasLegacyUser = runtime?.mcpLegacy?.user.exists ?? false;

  const resetDraft = () => {
    setEditingName(null);
    setDraft({
      name: "",
      transportType: "stdio",
      command: "",
      args: "",
      cwd: "",
      url: "",
      required: false,
      retries: "",
      authType: "none",
      headerName: "",
      prefix: "",
      keyId: "",
      scope: "",
      resource: "",
      oauthMode: "auto",
    });
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">MCP servers</h1>
        <p className="text-sm text-muted-foreground">Manage layered MCP servers via control socket messages.</p>
      </div>

      {workspace ? (
        <Card className="border-border/80 bg-card/85">
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>Workspace-level entries are editable. User/system layers are read-only.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {workspaces.length > 1 ? (
              <Select value={workspace.id} onValueChange={(value) => void selectWorkspace(value)}>
                <SelectTrigger aria-label="Active workspace">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <div className="text-xs text-muted-foreground">{workspace.path}</div>
            <Button variant="outline" type="button" onClick={() => void requestWorkspaceMcpServers(workspace.id)}>
              Refresh snapshot
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {workspace && (hasLegacyWorkspace || hasLegacyUser) ? (
        <Card className="border-amber-300/60 bg-amber-50/60">
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
        <Card className="border-border/80 bg-card/85">
          <CardHeader>
            <CardTitle>{editingName ? `Edit: ${editingName}` : "Add workspace MCP server"}</CardTitle>
            <CardDescription>
              Writes to <code>{`${workspace.path}/.cowork/mcp-servers.json`}</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
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
                  placeholder="Args (space separated)"
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
                  void upsertWorkspaceMcpServer(workspace.id, next, editingName ?? undefined);
                  resetDraft();
                }}
              >
                {editingName ? "Save changes" : "Add server"}
              </Button>
              {editingName ? (
                <Button type="button" variant="outline" onClick={resetDraft}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Effective servers</CardTitle>
          <CardDescription>
            Merged from workspace `.cowork`, user `.cowork/config`, built-in config, and legacy fallback.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {servers.length === 0 ? <div className="text-xs text-muted-foreground">No MCP servers configured.</div> : null}
          {servers.map((server) => {
            const validation = validationByName[server.name];
            const canEdit = server.source === "workspace";
            const apiKeyDraft = apiKeyByName[server.name] ?? "";
            const oauthCode = oauthCodeByName[server.name] ?? "";

            return (
              <div key={server.name} className="rounded-md border border-border/70 bg-muted/20 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{server.name}</span>
                  <Badge variant={canEdit ? "default" : "secondary"}>{sourceLabel(server.source)}</Badge>
                  <Badge variant="outline">auth: {server.authMode}</Badge>
                </div>
                <div className="mt-1 font-mono text-muted-foreground">{formatTransport(server)}</div>
                <div className="mt-1 text-muted-foreground">{server.authMessage}</div>

                {validation ? (
                  <div className="mt-2 text-muted-foreground">
                    Last validation: {validation.ok ? "ok" : "failed"} ({validation.mode})
                    {typeof validation.toolCount === "number" ? `, tools=${validation.toolCount}` : ""}
                    {typeof validation.latencyMs === "number" ? `, ${validation.latencyMs}ms` : ""}
                  </div>
                ) : null}

                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => workspace && void validateWorkspaceMcpServer(workspace.id, server.name)}>
                    Validate
                  </Button>
                  {canEdit ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setEditingName(server.name);
                          setDraft(draftFromServer(server));
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => workspace && void deleteWorkspaceMcpServer(workspace.id, server.name)}
                      >
                        Delete
                      </Button>
                    </>
                  ) : null}
                </div>

                {server.auth?.type === "oauth" ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => workspace && void authorizeWorkspaceMcpServerAuth(workspace.id, server.name)}
                    >
                      Sign in
                    </Button>
                    <Input
                      className="max-w-64"
                      placeholder="Paste OAuth code (optional)"
                      value={oauthCode}
                      onChange={(event) =>
                        setOauthCodeByName((prev) => ({
                          ...prev,
                          [server.name]: event.target.value,
                        }))
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
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
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      className="max-w-64"
                      placeholder="Paste API key"
                      value={apiKeyDraft}
                      onChange={(event) =>
                        setApiKeyByName((prev) => ({
                          ...prev,
                          [server.name]: event.target.value,
                        }))
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => workspace && void setWorkspaceMcpServerApiKey(workspace.id, server.name, apiKeyDraft)}
                    >
                      Save API key
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

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
    </div>
  );
}
