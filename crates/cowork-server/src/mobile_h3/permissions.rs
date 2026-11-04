use std::path::PathBuf;

use cowork_config::{
    get_ai_coworker_paths, host_platform, is_inside, path_has_link_component, resolve_home_dir,
    user_memory_db_path,
};
use cowork_protocol::{
    JsonRpcLiteClientMessage, JsonRpcLiteClientResponse, JsonRpcLiteError, JsonRpcLiteId,
    JsonRpcLiteNotification, JsonRpcLiteRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::jsonrpc::ConnectionRpcState;
use crate::mobile_h3::pairing_store::H3TrustedDeviceRecord;
use crate::registry::{ConnectionAccessFlags, ServerRuntimeState};
use crate::startup::MobileDevicePermissions;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MobilePermissionKey {
    Turns,
    ServerRequests,
    ProviderAuth,
    McpAuth,
    WorkspaceSettings,
    Backups,
    Conversations,
}

impl MobilePermissionKey {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turns => "turns",
            Self::ServerRequests => "serverRequests",
            Self::ProviderAuth => "providerAuth",
            Self::McpAuth => "mcpAuth",
            Self::WorkspaceSettings => "workspaceSettings",
            Self::Backups => "backups",
            Self::Conversations => "conversations",
        }
    }

    pub fn is_granted_on(self, perms: &MobileDevicePermissions) -> bool {
        match self {
            Self::Turns => perms.turns,
            Self::ServerRequests => perms.server_requests,
            Self::ProviderAuth => perms.provider_auth,
            Self::McpAuth => perms.mcp_auth,
            Self::WorkspaceSettings => perms.workspace_settings,
            Self::Backups => perms.backups,
            Self::Conversations => perms.conversations,
        }
    }
}

const ALWAYS_ALLOWED_H3_RPC_METHODS: &[&str] = &[
    "initialize",
    "initialized",
    "thread/unsubscribe",
    "workspace/list",
    "workspace/switch",
    "cowork/provider/catalog/read",
    "cowork/provider/authMethods/read",
    "cowork/provider/status/refresh",
    "cowork/provider/codexAppServer/status",
    "cowork/runtime/libreoffice/check",
    "cowork/agentProfiles/catalog/read",
    "cowork/skills/catalog/read",
    "cowork/skills/list",
    "cowork/skills/read",
    "cowork/skills/installation/read",
    "cowork/plugins/catalog/read",
    "cowork/plugins/read",
    "cowork/connectors/openai-native/list",
    "cowork/connectors/openai-native/refresh",
];

const TASK_READ_METHODS: &[&str] = &[
    "task/list",
    "task/read",
    "task/artifact/version/compare",
    "task/artifact/version/preview",
];

fn parse_jsonrpc_id(val: &Value) -> Option<JsonRpcLiteId> {
    match val {
        Value::String(s) => Some(JsonRpcLiteId::String(s.clone())),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(JsonRpcLiteId::Number(i))
            } else if let Some(u) = n.as_u64() {
                i64::try_from(u).ok().map(JsonRpcLiteId::Number)
            } else {
                n.as_f64()
                    .filter(|f| f.is_finite() && f.fract() == 0.0)
                    .map(|f| JsonRpcLiteId::Number(f as i64))
            }
        }
        _ => None,
    }
}

/// Parses an HTTP `/rpc` JSON body matching `src/server/transport/httpJsonRpcConnection.ts`
/// (`parseJsonRpcPayload`), tolerating inbound `"jsonrpc": "2.0"` while strictly validating
/// `id` and `method` types for `400` responses.
pub fn parse_http_jsonrpc_payload(raw: &Value) -> Result<JsonRpcLiteClientMessage, &'static str> {
    let Some(obj) = raw.as_object() else {
        return Err("JSON-RPC payload must be an object.");
    };

    if let Some(id_val) = obj.get("id")
        && !obj.contains_key("method")
    {
        let Some(id) = parse_jsonrpc_id(id_val) else {
            return Err("JSON-RPC response id must be a string or number.");
        };
        let error = obj.get("error").and_then(|err_val| {
            if err_val.is_null() {
                return None;
            }
            serde_json::from_value::<JsonRpcLiteError>(err_val.clone())
                .ok()
                .or_else(|| {
                    let code = err_val
                        .get("code")
                        .and_then(Value::as_i64)
                        .unwrap_or(-32000) as i32;
                    let message = err_val
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Client error")
                        .to_owned();
                    let data = err_val.get("data").cloned();
                    Some(JsonRpcLiteError {
                        code,
                        message,
                        data,
                    })
                })
        });
        return Ok(JsonRpcLiteClientMessage::ClientResponse(
            JsonRpcLiteClientResponse {
                id,
                result: obj.get("result").cloned(),
                error,
            },
        ));
    }

    let Some(method_str) = obj
        .get("method")
        .and_then(Value::as_str)
        .filter(|m| !m.trim().is_empty())
    else {
        return Err("JSON-RPC method is required.");
    };

    if let Some(id_val) = obj.get("id") {
        let Some(id) = parse_jsonrpc_id(id_val) else {
            return Err("JSON-RPC id must be a string or number.");
        };
        return Ok(JsonRpcLiteClientMessage::Request(JsonRpcLiteRequest {
            id,
            method: method_str.to_owned(),
            params: obj.get("params").cloned(),
        }));
    }

    Ok(JsonRpcLiteClientMessage::Notification(
        JsonRpcLiteNotification {
            method: method_str.to_owned(),
            params: obj.get("params").cloned(),
        },
    ))
}

pub fn get_required_h3_permissions(message: &JsonRpcLiteClientMessage) -> Vec<MobilePermissionKey> {
    let (method, params) = match message {
        JsonRpcLiteClientMessage::ClientResponse(_) => {
            return vec![MobilePermissionKey::ServerRequests];
        }
        JsonRpcLiteClientMessage::Request(r) => (r.method.as_str(), r.params.as_ref()),
        JsonRpcLiteClientMessage::Notification(n) => (n.method.as_str(), n.params.as_ref()),
    };

    // The LibreOffice probe is always allowed, but its `smoke` conversion launches a headless
    // `soffice` render, so it needs `turns` like any other command execution. Anything but an
    // omitted, `null` or `false` flag fails closed.
    if method == "cowork/runtime/libreoffice/check"
        && params
            .and_then(|p| p.get("smoke"))
            .is_some_and(|smoke| !smoke.is_null() && smoke != &Value::Bool(false))
    {
        return vec![MobilePermissionKey::Turns];
    }

    if ALWAYS_ALLOWED_H3_RPC_METHODS.contains(&method) {
        return Vec::new();
    }

    // Persisted session state. Reading a thread's harness context exposes conversation state;
    // deleting a session (which also stops its running turn), renaming it, or replacing its
    // harness context changes persisted thread state, like `thread/pinned/set`. None of these may
    // fall through to the `workspaceSettings` default.
    if method == "cowork/session/harnessContext/get" {
        return vec![MobilePermissionKey::Conversations];
    }
    if matches!(
        method,
        "cowork/session/delete" | "cowork/session/title/set" | "cowork/session/harnessContext/set"
    ) {
        return vec![
            MobilePermissionKey::Conversations,
            MobilePermissionKey::Turns,
        ];
    }

    // Routes that spawn a local process or run a model job: starting the local LM Studio server,
    // replacing the managed Codex app-server binary, generating memories from a thread's
    // conversation, and running or restoring skill-improvement jobs. They keep the
    // `workspaceSettings` grant they had and also need `turns`; memory generation reads the
    // source thread's conversation, so it needs `conversations` too.
    if matches!(
        method,
        "cowork/memory/advanced/generate" | "cowork/memory/advanced/folder/generate"
    ) {
        return vec![
            MobilePermissionKey::WorkspaceSettings,
            MobilePermissionKey::Conversations,
            MobilePermissionKey::Turns,
        ];
    }
    if matches!(
        method,
        "cowork/provider/lmstudio/local/start"
            | "cowork/provider/codexAppServer/update"
            | "cowork/skills/improvement/run"
            | "cowork/skills/improvement/restore"
    ) {
        return vec![
            MobilePermissionKey::WorkspaceSettings,
            MobilePermissionKey::Turns,
        ];
    }

    // External conversation import. Discovery, preview and mapping validation read external
    // transcripts and probe host paths; the import itself persists root threads and can register
    // host directories as workspaces, so `get_h3_request_denial` also refuses it outright.
    if method.starts_with("cowork/conversationImport/") {
        return match method {
            "cowork/conversationImport/sources/list"
            | "cowork/conversationImport/preview"
            | "cowork/conversationImport/workspaceMappings/validate" => vec![
                MobilePermissionKey::WorkspaceSettings,
                MobilePermissionKey::Conversations,
            ],
            _ => vec![
                MobilePermissionKey::WorkspaceSettings,
                MobilePermissionKey::Conversations,
                MobilePermissionKey::Turns,
            ],
        };
    }

    if matches!(
        method,
        "thread/fork" | "thread/pinned/set" | "thread/archived/set" | "command/execute"
    ) {
        return vec![
            MobilePermissionKey::Conversations,
            MobilePermissionKey::Turns,
        ];
    }

    if method == "thread/start" || method.starts_with("turn/") {
        return vec![MobilePermissionKey::Turns];
    }

    // Sub-agents run model turns with workspace tools (`spawn`, `input/send`, `resume`) or stop
    // them (`close`), so they need the same grants as starting/forking a turn; reading a child's
    // conversation (`list`, `inspect`, `wait`) needs `conversations`. None of them may fall
    // through to the `workspaceSettings` default, which would bypass a denied Turns grant.
    if matches!(
        method,
        "cowork/session/agent/spawn"
            | "cowork/session/agent/input/send"
            | "cowork/session/agent/resume"
            | "cowork/session/agent/close"
    ) {
        return vec![
            MobilePermissionKey::Conversations,
            MobilePermissionKey::Turns,
        ];
    }
    if matches!(
        method,
        "cowork/session/agent/list" | "cowork/session/agent/inspect" | "cowork/session/agent/wait"
    ) {
        return vec![MobilePermissionKey::Conversations];
    }
    if method.starts_with("cowork/session/agent/") {
        // Unknown future agent methods fail closed to the strictest grant set.
        return vec![
            MobilePermissionKey::Conversations,
            MobilePermissionKey::Turns,
        ];
    }

    if method == "cowork/session/state/read" {
        return vec![MobilePermissionKey::WorkspaceSettings];
    }

    if method == "cowork/workspace/bootstrap" {
        return vec![
            MobilePermissionKey::WorkspaceSettings,
            MobilePermissionKey::Conversations,
        ];
    }

    if matches!(
        method,
        "thread/list" | "thread/read" | "thread/hydrate" | "thread/resume" | "command/list"
    ) {
        return vec![MobilePermissionKey::Conversations];
    }

    if method.starts_with("task/") {
        if TASK_READ_METHODS.contains(&method) {
            return vec![MobilePermissionKey::Conversations];
        }
        return vec![
            MobilePermissionKey::Conversations,
            MobilePermissionKey::Turns,
        ];
    }

    if method.starts_with("cowork/provider/auth/") {
        return vec![MobilePermissionKey::ProviderAuth];
    }

    if method.starts_with("cowork/mcp/") {
        return required_h3_mcp_permissions(method);
    }

    if method.starts_with("cowork/memory/")
        || method == "cowork/plugins/install/preview"
        || method == "cowork/skills/install/preview"
        || method == "cowork/workspace/presentation/preview"
        || method.starts_with("cowork/workspace/document/")
        || method.starts_with("cowork/workspace/spreadsheet/")
    {
        return vec![MobilePermissionKey::WorkspaceSettings];
    }

    if method.starts_with("cowork/backups/") {
        return vec![MobilePermissionKey::Backups];
    }

    vec![MobilePermissionKey::WorkspaceSettings]
}

/// Grants for the `cowork/mcp/*` surface. This is deliberately stricter than TS
/// (`src/server/transport/h3/permissions.ts`), which only required `workspaceSettings` (plus
/// `mcpAuth` for auth) for every MCP method.
///
/// Any method that can connect to a configured server can start its stdio command, i.e. spawn an
/// arbitrary local subprocess with no approval or sandbox, so it also needs `turns`, the grant
/// that already lets a device run workspace commands through model turns. `workspaceSettings`
/// alone only lets a device read and edit MCP config; it must not execute that config.
fn required_h3_mcp_permissions(method: &str) -> Vec<MobilePermissionKey> {
    match method {
        // Config reads and edits. Edits are additionally restricted to workspace-scoped targets by
        // `get_h3_request_denial`, and a newly written workspace server only auto-starts when the
        // desktop user has set `trustWorkspaceMcp`.
        "cowork/mcp/list"
        | "cowork/mcp/servers/read"
        | "cowork/mcp/server/upsert"
        | "cowork/mcp/server/delete"
        | "cowork/mcp/server/setEnabled" => vec![MobilePermissionKey::WorkspaceSettings],
        // Connects to the server, which spawns a stdio server's configured command.
        "cowork/mcp/server/validate" => vec![
            MobilePermissionKey::WorkspaceSettings,
            MobilePermissionKey::Turns,
        ],
        // Starts an OAuth challenge against the server's HTTP endpoint; never spawns a command.
        "cowork/mcp/server/auth/authorize" => vec![MobilePermissionKey::McpAuth],
        // TS validates the server after a successful credential save (`McpManager.setApiKey` /
        // `callback`), which can execute its stdio command. The Rust handlers currently only save
        // the credential, but gate them as if they validate so restoring that parity cannot
        // reopen an execution path for a device without `turns`.
        "cowork/mcp/server/auth/setApiKey" | "cowork/mcp/server/auth/callback" => vec![
            MobilePermissionKey::McpAuth,
            MobilePermissionKey::WorkspaceSettings,
            MobilePermissionKey::Turns,
        ],
        // Unknown future MCP methods fail closed to the strictest grant set.
        _ if method.starts_with("cowork/mcp/server/auth/") => vec![
            MobilePermissionKey::McpAuth,
            MobilePermissionKey::WorkspaceSettings,
            MobilePermissionKey::Turns,
        ],
        _ => vec![
            MobilePermissionKey::WorkspaceSettings,
            MobilePermissionKey::Turns,
        ],
    }
}

/// A request the H3 transport refuses whatever grants the device holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum H3RequestDenial {
    /// The request would change the global user MCP layer (`~/.cowork/config/mcp-servers.json`
    /// or user-scoped plugin MCP overrides).
    UserMcpConfigMutation,
    /// The request would install, update, enable, disable or delete a user-scoped plugin. User
    /// plugins can bundle MCP servers, which join the user MCP layer.
    UserPluginConfigMutation,
    /// The request would add a skill to the user (`global`) layer, which every workspace's turns
    /// load as instructions.
    UserSkillConfigMutation,
    /// The request would create, change, copy into or delete a user (`global`) agent profile,
    /// which every workspace's sub-agents can use.
    UserAgentProfileConfigMutation,
    /// The request would write or delete user-scoped memory, which every workspace's turns load.
    UserMemoryMutation,
    /// `cowork/conversationImport/import` persists root threads and can register host directories
    /// as workspaces.
    ConversationImportDesktopOnly,
}

impl H3RequestDenial {
    /// Stable machine-readable reason, returned as `error.data.reason`.
    pub fn reason(self) -> &'static str {
        match self {
            Self::UserMcpConfigMutation => "userMcpConfigReadOnly",
            Self::UserPluginConfigMutation => "userPluginConfigReadOnly",
            Self::UserSkillConfigMutation => "userSkillConfigReadOnly",
            Self::UserAgentProfileConfigMutation => "userAgentProfileConfigReadOnly",
            Self::UserMemoryMutation => "userMemoryReadOnly",
            Self::ConversationImportDesktopOnly => "conversationImportDesktopOnly",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::UserMcpConfigMutation => {
                "Paired mobile devices can only change workspace MCP servers. Edit user (global) \
                 MCP servers in Cowork Desktop."
            }
            Self::UserPluginConfigMutation => {
                "Paired mobile devices can only change workspace plugins. Install or change user \
                 (global) plugins in Cowork Desktop."
            }
            Self::UserSkillConfigMutation => {
                "Paired mobile devices can only add workspace skills. Install or copy user \
                 (global) skills in Cowork Desktop."
            }
            Self::UserAgentProfileConfigMutation => {
                "Paired mobile devices can only change workspace agent profiles. Change user \
                 (global) agent profiles in Cowork Desktop."
            }
            Self::UserMemoryMutation => {
                "Paired mobile devices can only change workspace memory. Edit user memory in \
                 Cowork Desktop."
            }
            Self::ConversationImportDesktopOnly => {
                "Importing conversations can add workspaces, so it is only available in Cowork \
                 Desktop."
            }
        }
    }
}

/// Refusals that depend on request params rather than on the method alone. They are checked after
/// `get_required_h3_permissions`, so a missing grant is still reported as such first.
///
/// A device's trust is scoped to a workspace, but user-layer MCP servers, including those bundled
/// by user-scoped plugins, start for every workspace and are exempt from the `trustWorkspaceMcp`
/// gate (they auto-start on the next turn and validate without the trust check). Writing one is
/// therefore a deferred, global command execution primitive, so no grant combination lets a
/// paired device change the user MCP or plugin layer; that stays a desktop-only action. Workspace
/// MCP servers and workspace plugins stay editable because their MCP servers only start once the
/// desktop user sets `trustWorkspaceMcp`. Skills cannot declare MCP servers, but a user-scoped
/// (`global`) skill is loaded as instructions into every workspace's turns, so a device trusted
/// for one workspace could steer the agent in all of them. Adding skills to the user layer
/// (install, copy, import) is therefore desktop-only too; workspace skills stay installable.
/// Enabling, disabling, deleting or updating an already-installed skill is not refused: it only
/// acts on content the desktop user chose. User (`global`) agent profiles and user-scoped memory
/// likewise reach every workspace (sub-agent instructions and memory loaded into every turn), so
/// creating, copying into, changing or deleting them is desktop-only; workspace profiles and
/// workspace memory stay editable. A conversation import can register arbitrary host directories
/// as workspaces (and persist threads that can then run turns there), so it is desktop-only too.
/// TS had none of these checks.
pub fn get_h3_request_denial(
    message: &JsonRpcLiteClientMessage,
    workspace_targets_allowed: impl FnOnce(Option<&str>, &[&str]) -> bool,
) -> Option<H3RequestDenial> {
    let (method, params) = match message {
        JsonRpcLiteClientMessage::ClientResponse(_) => return None,
        JsonRpcLiteClientMessage::Request(r) => (r.method.as_str(), r.params.as_ref()),
        JsonRpcLiteClientMessage::Notification(n) => (n.method.as_str(), n.params.as_ref()),
    };
    let param = |key: &str| params.and_then(|p| p.get(key)).filter(|v| !v.is_null());
    let is_workspace = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .is_some_and(|s| s.trim() == "workspace")
    };

    // Plugin installs require `targetScope`; update/enable/disable/delete take an optional
    // `scope` and, when it is omitted, act on the first installed plugin with that id in any
    // scope, which may be a user plugin. Only an explicit workspace scope is accepted.
    let cwd = param("cwd").and_then(Value::as_str);
    let plugin_mutation: Option<(&str, &[&str])> = match method {
        "cowork/plugins/install" | "cowork/import/plugin" => {
            Some(("targetScope", &[".cowork/plugins"]))
        }
        "cowork/plugins/update" => Some(("scope", &[".cowork/plugins"])),
        "cowork/plugins/enable" | "cowork/plugins/disable" => {
            Some(("scope", &[".cowork/plugins.json"]))
        }
        // Deletion can remove an installation from either discovery root and edit its override.
        "cowork/plugins/delete" => Some((
            "scope",
            &[".cowork/plugins", ".agents/plugins", ".cowork/plugins.json"],
        )),
        _ => None,
    };
    if let Some((key, destinations)) = plugin_mutation {
        return (!is_workspace(param(key)) || !workspace_targets_allowed(cwd, destinations))
            .then_some(H3RequestDenial::UserPluginConfigMutation);
    }

    // `cowork/skills/*` scopes are `project` | `global`; `cowork/import/skill` uses
    // `workspace` | `user`. Anything but the workspace value (including a missing one) is refused.
    let skill_workspace_scope = match method {
        "cowork/skills/install" | "cowork/skills/installation/copy" => Some("project"),
        "cowork/import/skill" => Some("workspace"),
        _ => None,
    };
    if let Some(workspace_value) = skill_workspace_scope {
        let is_workspace_skill_scope = param("targetScope")
            .and_then(Value::as_str)
            .is_some_and(|s| s.trim() == workspace_value);
        return (!is_workspace_skill_scope || !workspace_targets_allowed(cwd, &[".cowork/skills"]))
            .then_some(H3RequestDenial::UserSkillConfigMutation);
    }

    if method == "cowork/conversationImport/import" {
        return Some(H3RequestDenial::ConversationImportDesktopOnly);
    }

    // Agent profile scopes are `workspace` | `global`. `workspaceAvailability/set` only toggles a
    // global profile for this workspace, but it writes the workspace overrides file, so its
    // destination is still checked. Unknown future profile mutations fail closed.
    if method.starts_with("cowork/agentProfiles/") && method != "cowork/agentProfiles/catalog/read"
    {
        let scope_ok = match method {
            "cowork/agentProfiles/upsert" => {
                is_workspace(param("profile").and_then(|profile| profile.get("scope")))
            }
            "cowork/agentProfiles/delete" => is_workspace(param("scope")),
            "cowork/agentProfiles/copy" => {
                is_workspace(param("copy").and_then(|copy| copy.get("targetScope")))
            }
            "cowork/agentProfiles/workspaceAvailability/set" => true,
            _ => false,
        };
        return (!scope_ok || !workspace_targets_allowed(cwd, &[".cowork/agent-profiles"]))
            .then_some(H3RequestDenial::UserAgentProfileConfigMutation);
    }

    // Memory scopes are `workspace` | `user`; the handler treats anything but `user` as the
    // workspace, but only an explicit workspace scope is accepted here. A workspace's memory
    // database is `<cwd>/.cowork/memory.sqlite`, which is the user database when `cwd` is home.
    if matches!(method, "cowork/memory/upsert" | "cowork/memory/delete") {
        return (!is_workspace(param("scope"))
            || !workspace_targets_allowed(cwd, &[".cowork/memory.sqlite"]))
        .then_some(H3RequestDenial::UserMemoryMutation);
    }

    let (workspace_scope, destinations): (bool, &[&str]) = match method {
        // Rename and delete can also migrate the workspace server's stored credentials.
        "cowork/mcp/server/upsert" | "cowork/mcp/server/delete" => (
            param("source").is_none() || is_workspace(param("source")),
            &[
                ".cowork/mcp-servers.json",
                ".cowork/auth/mcp-credentials.json",
            ],
        ),
        "cowork/mcp/server/setEnabled" => {
            let plugin_scope = param("pluginScope");
            match param("source").and_then(Value::as_str).map(str::trim) {
                Some("workspace") => (
                    plugin_scope.is_none() || is_workspace(plugin_scope),
                    &[".cowork/mcp-servers.json"],
                ),
                Some("plugin") => (is_workspace(plugin_scope), &[".cowork/plugins.json"]),
                _ => return Some(H3RequestDenial::UserMcpConfigMutation),
            }
        }
        _ => return None,
    };
    (!workspace_scope || !workspace_targets_allowed(cwd, destinations))
        .then_some(H3RequestDenial::UserMcpConfigMutation)
}

/// A scope is relative to the requested cwd. Home can itself be a registered workspace,
/// and workspace metadata can be linked to the user layer.
pub(super) fn workspace_targets_allowed(
    runtime: &ServerRuntimeState,
    raw_cwd: Option<&str>,
    destinations: &[&str],
) -> bool {
    let Ok(cwd) = runtime.resolve_workspace_path(raw_cwd, "mobile workspace settings") else {
        return false;
    };
    if !runtime.is_create_thread_workspace(&cwd) {
        return false;
    }
    let user_roots = user_layer_roots(runtime);
    destinations.iter().all(|relative| {
        let target = cwd.join(relative);
        !path_has_link_component(&target)
            && !user_roots
                .iter()
                .any(|root| is_inside(root, &target) || is_inside(&target, root))
    })
}

/// User-layer locations a workspace destination may never reach: user plugins, skills, agent
/// profiles, config, credentials and the user memory database. They are derived the way the
/// server resolves them (`get_ai_coworker_paths` over the runtime home) and, when
/// `COWORK_HOME_OVERRIDE` or `HOME` names a different home, from that home too.
fn user_layer_roots(runtime: &ServerRuntimeState) -> Vec<PathBuf> {
    let mut homes = vec![runtime.homedir.clone()];
    let env_home = resolve_home_dir(&runtime.env, host_platform());
    if env_home != runtime.homedir {
        homes.push(env_home);
    }
    homes
        .iter()
        .flat_map(|home| {
            let paths = get_ai_coworker_paths(Some(home), &runtime.env);
            [
                paths.root_dir.join("plugins"),
                paths.skills_dir.clone(),
                paths.root_dir.join("agent-profiles"),
                user_memory_db_path(&paths.root_dir),
                paths.config_dir.clone(),
                paths.auth_dir.clone(),
                home.join(".agents/plugins"),
                home.join(".agents/skills"),
            ]
        })
        .collect()
}

pub fn apply_trusted_device_permissions(
    runtime: &ServerRuntimeState,
    conn_state: &ConnectionRpcState,
    trusted_device: &H3TrustedDeviceRecord,
) {
    let flags = ConnectionAccessFlags {
        workspace_control_events_allowed: trusted_device.permissions.workspace_settings,
        task_read_allowed: trusted_device.permissions.conversations,
        task_mutation_allowed: trusted_device.permissions.conversations
            && trusted_device.permissions.turns,
    };
    conn_state.set_task_permissions(flags.task_read_allowed, flags.task_mutation_allowed);
    runtime.set_connection_access(&conn_state.connection_id, flags);
}

#[cfg(test)]
mod tests {
    use super::*;
    use MobilePermissionKey::{Conversations, McpAuth, Turns, WorkspaceSettings};
    use serde_json::json;

    fn scope_denial(message: &JsonRpcLiteClientMessage) -> Option<H3RequestDenial> {
        get_h3_request_denial(message, |_, _| true)
    }

    fn request(method: &str, params: Value) -> JsonRpcLiteClientMessage {
        parse_http_jsonrpc_payload(&json!({ "id": 1, "method": method, "params": params })).unwrap()
    }

    fn required(method: &str) -> Vec<MobilePermissionKey> {
        get_required_h3_permissions(&request(method, json!({})))
    }

    #[test]
    fn mcp_methods_that_can_spawn_a_server_command_require_turns() {
        assert_eq!(
            required("cowork/mcp/server/validate"),
            vec![WorkspaceSettings, Turns]
        );
        for method in [
            "cowork/mcp/server/auth/setApiKey",
            "cowork/mcp/server/auth/callback",
        ] {
            assert_eq!(
                required(method),
                vec![McpAuth, WorkspaceSettings, Turns],
                "{method}"
            );
        }
    }

    #[test]
    fn mcp_config_reads_and_edits_need_only_workspace_settings() {
        for method in [
            "cowork/mcp/list",
            "cowork/mcp/servers/read",
            "cowork/mcp/server/upsert",
            "cowork/mcp/server/delete",
            "cowork/mcp/server/setEnabled",
        ] {
            assert_eq!(required(method), vec![WorkspaceSettings], "{method}");
        }
        assert_eq!(required("cowork/mcp/server/auth/authorize"), vec![McpAuth]);
    }

    #[test]
    fn unknown_mcp_methods_fail_closed_to_turns() {
        assert_eq!(
            required("cowork/mcp/server/reconnect"),
            vec![WorkspaceSettings, Turns]
        );
        assert_eq!(
            required("cowork/mcp/server/auth/refresh"),
            vec![McpAuth, WorkspaceSettings, Turns]
        );
    }

    #[test]
    fn user_layer_mcp_edits_are_denied_and_workspace_edits_allowed() {
        let denied = Some(H3RequestDenial::UserMcpConfigMutation);
        for method in ["cowork/mcp/server/upsert", "cowork/mcp/server/delete"] {
            assert_eq!(scope_denial(&request(method, json!({}))), None);
            assert_eq!(
                scope_denial(&request(method, json!({ "source": null }))),
                None
            );
            assert_eq!(
                scope_denial(&request(method, json!({ "source": "workspace" }))),
                None
            );
            for source in [json!("user"), json!(" user "), json!("plugin"), json!(1)] {
                assert_eq!(
                    scope_denial(&request(method, json!({ "source": source }))),
                    denied,
                    "{method} {source}"
                );
            }
        }
        // Params that are not an object carry no source; the handler rejects them itself.
        assert_eq!(
            scope_denial(&request("cowork/mcp/server/upsert", json!([]))),
            None
        );

        let set_enabled =
            |params: Value| scope_denial(&request("cowork/mcp/server/setEnabled", params));
        assert_eq!(set_enabled(json!({ "source": "workspace" })), None);
        assert_eq!(
            set_enabled(json!({ "source": "plugin", "pluginScope": "workspace" })),
            None
        );
        for params in [
            json!({ "source": "user" }),
            json!({ "source": "plugin", "pluginScope": "user" }),
            json!({ "source": "plugin" }),
            json!({ "source": "workspace", "pluginScope": "user" }),
            json!({ "source": "system" }),
            json!({}),
        ] {
            assert_eq!(set_enabled(params.clone()), denied, "{params}");
        }

        // Notifications are checked the same way; other methods and client responses are not.
        let notification = parse_http_jsonrpc_payload(&json!({
            "method": "cowork/mcp/server/upsert",
            "params": { "source": "user" }
        }))
        .unwrap();
        assert_eq!(scope_denial(&notification), denied);
        assert_eq!(
            scope_denial(&request(
                "cowork/mcp/server/validate",
                json!({ "source": "user" })
            )),
            None
        );
        let client_response =
            parse_http_jsonrpc_payload(&json!({ "id": 1, "result": {} })).unwrap();
        assert_eq!(scope_denial(&client_response), None);
    }

    #[test]
    fn user_scoped_skill_additions_are_denied_and_workspace_scoped_allowed() {
        let denied = Some(H3RequestDenial::UserSkillConfigMutation);
        for (method, workspace, user) in [
            ("cowork/skills/install", "project", "global"),
            ("cowork/skills/installation/copy", "project", "global"),
            ("cowork/import/skill", "workspace", "user"),
        ] {
            assert_eq!(
                scope_denial(&request(method, json!({ "targetScope": workspace }))),
                None,
                "{method}"
            );
            for params in [
                json!({ "targetScope": user }),
                json!({ "targetScope": null }),
                json!({}),
                json!({ "targetScope": 1 }),
            ] {
                assert_eq!(
                    scope_denial(&request(method, params.clone())),
                    denied,
                    "{method} {params}"
                );
            }
        }
        // A workspace scope still needs an authorized workspace destination.
        assert_eq!(
            get_h3_request_denial(
                &request("cowork/skills/install", json!({ "targetScope": "project" })),
                |_, _| false
            ),
            denied
        );
        // Changing already-installed skills and previewing a source are not refused.
        for method in [
            "cowork/skills/enable",
            "cowork/skills/disable",
            "cowork/skills/delete",
            "cowork/skills/installation/update",
            "cowork/skills/install/preview",
        ] {
            assert_eq!(
                scope_denial(&request(method, json!({ "targetScope": "global" }))),
                None,
                "{method}"
            );
        }
    }

    #[test]
    fn session_state_routes_require_conversation_grants() {
        assert_eq!(
            required("cowork/session/harnessContext/get"),
            vec![Conversations]
        );
        for method in [
            "cowork/session/delete",
            "cowork/session/title/set",
            "cowork/session/harnessContext/set",
        ] {
            assert_eq!(required(method), vec![Conversations, Turns], "{method}");
        }
    }

    #[test]
    fn subprocess_and_model_job_routes_require_turns() {
        for method in [
            "cowork/provider/lmstudio/local/start",
            "cowork/provider/codexAppServer/update",
            "cowork/skills/improvement/run",
            "cowork/skills/improvement/restore",
        ] {
            assert_eq!(required(method), vec![WorkspaceSettings, Turns], "{method}");
        }
        for method in [
            "cowork/memory/advanced/generate",
            "cowork/memory/advanced/folder/generate",
        ] {
            assert_eq!(
                required(method),
                vec![WorkspaceSettings, Conversations, Turns],
                "{method}"
            );
        }
        // Neighbouring reads keep their previous grants.
        assert_eq!(
            required("cowork/provider/lmstudio/local/status"),
            vec![WorkspaceSettings]
        );
        assert_eq!(
            required("cowork/skills/improvement/status"),
            vec![WorkspaceSettings]
        );
        assert_eq!(
            required("cowork/memory/advanced/list"),
            vec![WorkspaceSettings]
        );
        assert!(required("cowork/provider/codexAppServer/status").is_empty());
    }

    #[test]
    fn libreoffice_smoke_check_requires_turns() {
        let check = |params: Value| {
            get_required_h3_permissions(&request("cowork/runtime/libreoffice/check", params))
        };
        for params in [
            json!({}),
            json!({ "smoke": false }),
            json!({ "smoke": null }),
            json!({ "cwd": "/tmp" }),
        ] {
            assert!(check(params.clone()).is_empty(), "{params}");
        }
        for params in [
            json!({ "smoke": true }),
            json!({ "smoke": "true" }),
            json!({ "smoke": 1 }),
        ] {
            assert_eq!(check(params.clone()), vec![Turns], "{params}");
        }
    }

    #[test]
    fn conversation_import_requires_conversations_and_import_is_desktop_only() {
        for method in [
            "cowork/conversationImport/sources/list",
            "cowork/conversationImport/preview",
            "cowork/conversationImport/workspaceMappings/validate",
        ] {
            assert_eq!(
                required(method),
                vec![WorkspaceSettings, Conversations],
                "{method}"
            );
            assert_eq!(scope_denial(&request(method, json!({}))), None, "{method}");
        }
        for method in [
            "cowork/conversationImport/import",
            "cowork/conversationImport/future",
        ] {
            assert_eq!(
                required(method),
                vec![WorkspaceSettings, Conversations, Turns],
                "{method}"
            );
        }
        assert_eq!(
            scope_denial(&request("cowork/conversationImport/import", json!({}))),
            Some(H3RequestDenial::ConversationImportDesktopOnly)
        );
    }

    #[test]
    fn user_agent_profile_changes_are_denied_and_workspace_changes_allowed() {
        let denied = Some(H3RequestDenial::UserAgentProfileConfigMutation);
        let cases = [
            (
                "cowork/agentProfiles/upsert",
                json!({ "profile": { "scope": "workspace", "id": "p" } }),
                json!({ "profile": { "scope": "global", "id": "p" } }),
            ),
            (
                "cowork/agentProfiles/delete",
                json!({ "scope": "workspace", "id": "p" }),
                json!({ "scope": "global", "id": "p" }),
            ),
            (
                "cowork/agentProfiles/copy",
                json!({ "copy": { "sourceRef": "global:p", "targetScope": "workspace" } }),
                json!({ "copy": { "sourceRef": "workspace:p", "targetScope": "global" } }),
            ),
        ];
        for (method, workspace, global) in cases {
            assert_eq!(
                scope_denial(&request(method, workspace.clone())),
                None,
                "{method}"
            );
            assert_eq!(scope_denial(&request(method, global)), denied, "{method}");
            // A missing scope fails closed.
            assert_eq!(
                scope_denial(&request(method, json!({}))),
                denied,
                "{method}"
            );
            // A workspace scope still needs an authorized workspace destination.
            assert_eq!(
                get_h3_request_denial(&request(method, workspace), |_, _| false),
                denied,
                "{method}"
            );
        }
        let availability = request(
            "cowork/agentProfiles/workspaceAvailability/set",
            json!({ "id": "p", "disabled": true }),
        );
        assert_eq!(scope_denial(&availability), None);
        assert_eq!(get_h3_request_denial(&availability, |_, _| false), denied);
        assert_eq!(
            scope_denial(&request("cowork/agentProfiles/catalog/read", json!({}))),
            None
        );
        assert_eq!(
            scope_denial(&request(
                "cowork/agentProfiles/rename",
                json!({ "scope": "workspace" })
            )),
            denied
        );
    }

    #[test]
    fn user_memory_changes_are_denied_and_workspace_changes_allowed() {
        let denied = Some(H3RequestDenial::UserMemoryMutation);
        for method in ["cowork/memory/upsert", "cowork/memory/delete"] {
            let workspace = request(method, json!({ "scope": "workspace", "id": "hot" }));
            assert_eq!(scope_denial(&workspace), None, "{method}");
            assert_eq!(
                get_h3_request_denial(&workspace, |_, _| false),
                denied,
                "{method}"
            );
            for params in [
                json!({ "scope": "user", "id": "hot" }),
                json!({ "id": "hot" }),
                json!({ "scope": null }),
            ] {
                assert_eq!(
                    scope_denial(&request(method, params.clone())),
                    denied,
                    "{method} {params}"
                );
            }
        }
        assert_eq!(
            scope_denial(&request("cowork/memory/list", json!({ "scope": "user" }))),
            None
        );
    }

    #[test]
    fn user_scoped_plugin_changes_are_denied_and_workspace_scoped_allowed() {
        let denied = Some(H3RequestDenial::UserPluginConfigMutation);
        for (method, key) in [
            ("cowork/plugins/install", "targetScope"),
            ("cowork/import/plugin", "targetScope"),
            ("cowork/plugins/update", "scope"),
            ("cowork/plugins/enable", "scope"),
            ("cowork/plugins/disable", "scope"),
            ("cowork/plugins/delete", "scope"),
        ] {
            assert_eq!(
                scope_denial(&request(method, json!({ key: "workspace" }))),
                None,
                "{method}"
            );
            // An omitted scope can resolve to a user plugin, so it fails closed too.
            for params in [
                json!({ key: "user" }),
                json!({ key: null }),
                json!({}),
                json!({ key: 1 }),
            ] {
                assert_eq!(
                    scope_denial(&request(method, params.clone())),
                    denied,
                    "{method} {params}"
                );
            }
        }
        // Previews only read the source.
        assert_eq!(
            scope_denial(&request(
                "cowork/plugins/install/preview",
                json!({ "targetScope": "user" })
            )),
            None
        );
    }
}
