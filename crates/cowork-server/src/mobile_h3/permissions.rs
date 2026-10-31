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

    if matches!(
        method,
        "cowork/mcp/server/auth/setApiKey" | "cowork/mcp/server/auth/callback"
    ) {
        return vec![
            MobilePermissionKey::McpAuth,
            MobilePermissionKey::WorkspaceSettings,
        ];
    }

    if method.starts_with("cowork/mcp/server/auth/") {
        return vec![MobilePermissionKey::McpAuth];
    }

    if method.starts_with("cowork/mcp/")
        || method.starts_with("cowork/memory/")
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
