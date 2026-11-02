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
    "cowork/session/harnessContext/get",
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
    let method = match message {
        JsonRpcLiteClientMessage::ClientResponse(_) => {
            return vec![MobilePermissionKey::ServerRequests];
        }
        JsonRpcLiteClientMessage::Request(r) => r.method.as_str(),
        JsonRpcLiteClientMessage::Notification(n) => n.method.as_str(),
    };

    if ALWAYS_ALLOWED_H3_RPC_METHODS.contains(&method) {
        return Vec::new();
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
}

impl H3RequestDenial {
    /// Stable machine-readable reason, returned as `error.data.reason`.
    pub fn reason(self) -> &'static str {
        match self {
            Self::UserMcpConfigMutation => "userMcpConfigReadOnly",
            Self::UserPluginConfigMutation => "userPluginConfigReadOnly",
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
/// desktop user sets `trustWorkspaceMcp`. User-scoped (`global`) skill installs stay allowed:
/// skills are instruction bundles that cannot declare MCP servers and only run through a turn,
/// which needs `turns`. TS had no such check.
pub fn get_h3_request_denial(message: &JsonRpcLiteClientMessage) -> Option<H3RequestDenial> {
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
    let plugin_scope_key = match method {
        "cowork/plugins/install" | "cowork/import/plugin" => Some("targetScope"),
        "cowork/plugins/update"
        | "cowork/plugins/enable"
        | "cowork/plugins/disable"
        | "cowork/plugins/delete" => Some("scope"),
        _ => None,
    };
    if let Some(key) = plugin_scope_key {
        return (!is_workspace(param(key))).then_some(H3RequestDenial::UserPluginConfigMutation);
    }

    let targets_workspace_only = match method {
        // The handlers write `source: "user"` to the user layer and default anything else to the
        // workspace layer; only accept an omitted or explicit workspace source so a future change
        // to that default cannot silently widen this.
        "cowork/mcp/server/upsert" | "cowork/mcp/server/delete" => {
            param("source").is_none() || is_workspace(param("source"))
        }
        // `source` is required here and may name the user layer directly or, for plugin servers,
        // through `pluginScope: "user"`.
        "cowork/mcp/server/setEnabled" => {
            let plugin_scope = param("pluginScope");
            let plugin_scope_ok = plugin_scope.is_none() || is_workspace(plugin_scope);
            match param("source").and_then(Value::as_str).map(str::trim) {
                Some("workspace") => plugin_scope_ok,
                Some("plugin") => is_workspace(plugin_scope),
                _ => false,
            }
        }
        _ => true,
    };
    (!targets_workspace_only).then_some(H3RequestDenial::UserMcpConfigMutation)
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
    use MobilePermissionKey::{McpAuth, Turns, WorkspaceSettings};
    use serde_json::json;

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
            assert_eq!(get_h3_request_denial(&request(method, json!({}))), None);
            assert_eq!(
                get_h3_request_denial(&request(method, json!({ "source": null }))),
                None
            );
            assert_eq!(
                get_h3_request_denial(&request(method, json!({ "source": "workspace" }))),
                None
            );
            for source in [json!("user"), json!(" user "), json!("plugin"), json!(1)] {
                assert_eq!(
                    get_h3_request_denial(&request(method, json!({ "source": source }))),
                    denied,
                    "{method} {source}"
                );
            }
        }
        // Params that are not an object carry no source; the handler rejects them itself.
        assert_eq!(
            get_h3_request_denial(&request("cowork/mcp/server/upsert", json!([]))),
            None
        );

        let set_enabled =
            |params: Value| get_h3_request_denial(&request("cowork/mcp/server/setEnabled", params));
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
        assert_eq!(get_h3_request_denial(&notification), denied);
        assert_eq!(
            get_h3_request_denial(&request(
                "cowork/mcp/server/validate",
                json!({ "source": "user" })
            )),
            None
        );
        let client_response =
            parse_http_jsonrpc_payload(&json!({ "id": 1, "result": {} })).unwrap();
        assert_eq!(get_h3_request_denial(&client_response), None);
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
                get_h3_request_denial(&request(method, json!({ key: "workspace" }))),
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
                    get_h3_request_denial(&request(method, params.clone())),
                    denied,
                    "{method} {params}"
                );
            }
        }
        // Skills cannot carry MCP servers; global skill installs are not refused.
        assert_eq!(
            get_h3_request_denial(&request(
                "cowork/skills/install",
                json!({ "targetScope": "global" })
            )),
            None
        );
        // Previews only read the source.
        assert_eq!(
            get_h3_request_denial(&request(
                "cowork/plugins/install/preview",
                json!({ "targetScope": "user" })
            )),
            None
        );
    }
}
