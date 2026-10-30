use std::collections::HashMap;

use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    JSONRPC_PROTOCOL_VERSION, JsonRpcLiteError, WEBSOCKET_PROTOCOL_VERSION, WEBSOCKET_SUBPROTOCOL,
    error_codes,
};

/// Canonical 21 JSON-RPC-lite schema namespaces (`src/server/jsonrpc/schema.ts` parity).
pub const NAMESPACE_NAMES: [&str; 21] = [
    "core",
    "threadTurn",
    "threadManagement",
    "session",
    "agents",
    "agentProfiles",
    "connectors",
    "creation",
    "provider",
    "runtime",
    "mcp",
    "plugins",
    "skills",
    "marketplaces",
    "import",
    "memory",
    "backups",
    "skillImprovement",
    "commands",
    "workspace",
    "tasks",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experimental_api: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_retry_lineage: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opt_out_notification_methods: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ClientCapabilities>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InitializedParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subprotocol: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NegotiatedServerCapabilities {
    pub experimental_api: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_retry_lineage: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransportDescriptor {
    #[serde(rename = "type")]
    pub transport_type: String,
    pub protocol_mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub server_info: ServerInfo,
    pub capabilities: NegotiatedServerCapabilities,
    pub transport: TransportDescriptor,
}

/// Validates strict `initialize` request parameters (`schema.core.ts` parity).
pub fn parse_initialize_params(
    params: Option<&Value>,
) -> Result<InitializeParams, JsonRpcLiteError> {
    let Some(raw) = params else {
        return Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            "Invalid initialize params",
        ));
    };
    let parsed: InitializeParams = serde_json::from_value(raw.clone()).map_err(|err| {
        JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            format!("Invalid initialize params: {err}"),
        )
    })?;
    if parsed.client_info.name.trim().is_empty() {
        return Err(JsonRpcLiteError::new(
            error_codes::INVALID_PARAMS,
            "clientInfo.name must not be empty",
        ));
    }
    if let Some(caps) = &parsed.capabilities {
        if caps.experimental_api == Some(false) {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "capabilities.experimentalApi must be true when provided",
            ));
        }
        if caps.tool_retry_lineage == Some(false) {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "capabilities.toolRetryLineage must be true when provided",
            ));
        }
    }
    Ok(parsed)
}

/// Validates strict `initialized` parameters (`undefined`/`None` or `{}`).
pub fn parse_initialized_params(
    params: Option<&Value>,
) -> Result<InitializedParams, JsonRpcLiteError> {
    match params {
        None => Ok(InitializedParams {}),
        Some(raw) => serde_json::from_value(raw.clone()).map_err(|err| {
            JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                format!("Invalid initialized params: {err}"),
            )
        }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatus {
    #[serde(rename = "type")]
    pub status_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcThread {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub model_provider: String,
    pub model: String,
    pub cwd: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
    pub last_event_seq: u64,
    #[serde(default)]
    pub has_pending_ask: bool,
    #[serde(default)]
    pub has_pending_approval: bool,
    pub status: ThreadStatus,
    pub pinned: bool,
    pub pinned_at: Option<String>,
    pub archived: bool,
    pub archived_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<crate::ProjectedTurn>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplayHealth {
    pub trusted: bool,
    pub snapshot_required: bool,
    pub reason: String,
    pub tail_seq: u64,
    pub failed_write_count: u64,
    pub dropped_event_count: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadStartParams {
    pub cwd: Option<String>,
    #[serde(alias = "creationKey")]
    pub client_thread_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadResumeParams {
    pub thread_id: String,
    pub after_seq: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadListParams {
    pub cwd: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadReadParams {
    pub thread_id: String,
    pub include_turns: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadHydrateParams {
    pub thread_id: String,
    pub after_seq: Option<u64>,
    pub include_turns: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadUnsubscribeParams {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadPinnedSetParams {
    pub thread_id: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadArchivedSetParams {
    pub thread_id: String,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTitleSetParams {
    pub thread_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStateReadParams {
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionModelSetParams {
    pub thread_id: String,
    pub provider: Option<String>,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionUsageBudgetSetParams {
    pub thread_id: String,
    #[serde(default)]
    pub warn_at_usd: Option<Option<f64>>,
    #[serde(default)]
    pub stop_at_usd: Option<Option<f64>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionConfigSetParams {
    pub thread_id: String,
    pub config: MapOrObject,
}

pub type MapOrObject = serde_json::Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionHarnessContextGetParams {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessContextInput {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub objective: String,
    pub acceptance_criteria: Vec<String>,
    pub constraints: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionHarnessContextSetParams {
    pub thread_id: String,
    pub context: HarnessContextInput,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionDefaultsApplyParams {
    pub cwd: Option<String>,
    pub thread_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub enable_mcp: Option<bool>,
    pub config: Option<MapOrObject>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFileUploadParams {
    pub cwd: Option<String>,
    pub filename: String,
    pub content_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionDeleteParams {
    pub cwd: Option<String>,
    pub target_session_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceListParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSwitchParams {
    pub workspace_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceBootstrapParams {
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcWorkspaceSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    pub workspace_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_enable_mcp: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yolo: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandListParams {
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: String,
    pub hints: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandExecuteParams {
    pub thread_id: String,
    pub name: String,
    pub arguments: Option<String>,
    pub client_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreationPreflightParams {
    pub kind: String,
    pub cwd: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CreationRepairAction {
    #[serde(rename_all = "camelCase")]
    ConnectProvider {
        provider: String,
    },
    #[serde(rename_all = "camelCase")]
    OpenProviderSettings {
        provider: String,
    },
    #[serde(rename_all = "camelCase")]
    StartLmStudio {
        base_url: String,
        can_auto_start: bool,
    },
    InstallCodexRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreationReadinessCheck {
    pub id: String,
    pub status: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repair_action: Option<CreationRepairAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreationPreflightResult {
    pub ready: bool,
    pub checks: Vec<CreationReadinessCheck>,
}

/// Deterministic schema & namespace manifest exported for `packages/harness` codegen.
pub fn export_protocol_schema_manifest() -> Value {
    json!({
        "protocolVersion": JSONRPC_PROTOCOL_VERSION,
        "websocketProtocolVersion": WEBSOCKET_PROTOCOL_VERSION,
        "subprotocol": WEBSOCKET_SUBPROTOCOL,
        "namespaces": NAMESPACE_NAMES,
        "schemas": {
            "InitializeParams": schema_for!(InitializeParams),
            "InitializeResult": schema_for!(InitializeResult),
            "JsonRpcThread": schema_for!(JsonRpcThread),
            "ThreadStartParams": schema_for!(ThreadStartParams),
            "ThreadResumeParams": schema_for!(ThreadResumeParams),
            "ThreadListParams": schema_for!(ThreadListParams),
            "ThreadReadParams": schema_for!(ThreadReadParams),
            "ThreadHydrateParams": schema_for!(ThreadHydrateParams),
            "ThreadUnsubscribeParams": schema_for!(ThreadUnsubscribeParams),
            "ThreadPinnedSetParams": schema_for!(ThreadPinnedSetParams),
            "ThreadArchivedSetParams": schema_for!(ThreadArchivedSetParams),
            "SessionTitleSetParams": schema_for!(SessionTitleSetParams),
            "SessionStateReadParams": schema_for!(SessionStateReadParams),
            "SessionModelSetParams": schema_for!(SessionModelSetParams),
            "SessionUsageBudgetSetParams": schema_for!(SessionUsageBudgetSetParams),
            "SessionConfigSetParams": schema_for!(SessionConfigSetParams),
            "SessionHarnessContextGetParams": schema_for!(SessionHarnessContextGetParams),
            "SessionHarnessContextSetParams": schema_for!(SessionHarnessContextSetParams),
            "SessionDefaultsApplyParams": schema_for!(SessionDefaultsApplyParams),
            "SessionFileUploadParams": schema_for!(SessionFileUploadParams),
            "SessionDeleteParams": schema_for!(SessionDeleteParams),
            "WorkspaceListParams": schema_for!(WorkspaceListParams),
            "WorkspaceSwitchParams": schema_for!(WorkspaceSwitchParams),
            "WorkspaceBootstrapParams": schema_for!(WorkspaceBootstrapParams),
            "CommandListParams": schema_for!(CommandListParams),
            "CommandExecuteParams": schema_for!(CommandExecuteParams),
            "CreationPreflightParams": schema_for!(CreationPreflightParams),
            "CreationPreflightResult": schema_for!(CreationPreflightResult),
        }
    })
}
