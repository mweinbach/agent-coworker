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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCatalogReadParams {
    pub cwd: Option<String>,
    pub refresh: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAuthMethodsReadParams {
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderStatusRefreshParams {
    pub cwd: Option<String>,
    pub refresh_bedrock_discovery: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCodexAppServerStatusParams {
    pub cwd: Option<String>,
    pub check_latest: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCodexAppServerUpdateParams {
    pub cwd: Option<String>,
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderLmStudioLocalStatusParams {
    pub cwd: Option<String>,
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderLmStudioLocalStartParams {
    pub cwd: Option<String>,
    pub base_url: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAuthAuthorizeParams {
    pub cwd: Option<String>,
    pub provider: String,
    pub method_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAuthCallbackParams {
    pub cwd: Option<String>,
    pub provider: String,
    pub method_id: String,
    pub code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAuthLogoutParams {
    pub cwd: Option<String>,
    pub provider: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAuthSetApiKeyParams {
    pub cwd: Option<String>,
    pub provider: String,
    pub method_id: Option<String>,
    #[serde(alias = "key")]
    pub api_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAuthSetConfigParams {
    pub cwd: Option<String>,
    pub provider: String,
    pub method_id: String,
    pub values: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAuthCopyApiKeyParams {
    pub cwd: Option<String>,
    pub provider: String,
    pub source_provider: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCustomModelAddParams {
    pub cwd: Option<String>,
    pub provider: String,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCustomModelDeleteParams {
    pub cwd: Option<String>,
    pub provider: String,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderModelPreferencePatch {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderModelSetEnabledParams {
    pub cwd: Option<String>,
    pub provider: String,
    pub models: Vec<ProviderModelPreferencePatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderModelResetEnabledParams {
    pub cwd: Option<String>,
    pub provider: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorsOpenAiNativeListParams {
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorsOpenAiNativeRefreshParams {
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorsOpenAiNativeSetEnabledParams {
    pub cwd: Option<String>,
    pub connector_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum TurnInput {
    Text(String),
    Parts(Vec<Value>),
}

impl TurnInput {
    pub fn extract_text(&self) -> Result<String, String> {
        match self {
            Self::Text(s) => {
                if s.trim().is_empty() {
                    return Err("turn input text must not be empty".to_owned());
                }
                Ok(s.clone())
            }
            Self::Parts(parts) => {
                if parts.is_empty() {
                    return Err("turn input parts must not be empty".to_owned());
                }
                let mut chunks = Vec::new();
                for part in parts {
                    let Some(obj) = part.as_object() else {
                        return Err("turn input part must be an object".to_owned());
                    };
                    let kind = obj.get("type").and_then(Value::as_str).unwrap_or("text");
                    match kind {
                        "text" | "input_text" => {
                            let Some(t) = obj.get("text").and_then(Value::as_str) else {
                                return Err("text input part requires string `text`".to_owned());
                            };
                            chunks.push(t.to_owned());
                        }
                        "mention" | "file" => {
                            if let Some(p) = obj.get("path").and_then(Value::as_str) {
                                chunks.push(format!("@{p}"));
                            }
                        }
                        _ => {}
                    }
                }
                let joined = chunks.join("\n");
                if joined.trim().is_empty() {
                    return Err("turn input must include non-empty text".to_owned());
                }
                Ok(joined)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnStartParams {
    pub thread_id: String,
    pub client_message_id: Option<String>,
    pub input: TurnInput,
    pub references: Option<Vec<Value>>,
    pub retry: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnSteerParams {
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub client_message_id: Option<String>,
    pub input: TurnInput,
    pub references: Option<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnInterruptParams {
    pub thread_id: String,
    pub include_subagents: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLibreOfficeCheckParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smoke: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeLibreOfficeSmokeStatus {
    pub ok: bool,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeLibreOfficeStatusView {
    pub status: String,
    pub checked_at: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smoke: Option<RuntimeLibreOfficeSmokeStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeLibreOfficeCheckResult {
    pub status: RuntimeLibreOfficeStatusView,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RuntimeDiagnosticsReadParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDiagnosticsProgress {
    pub phase: String,
    pub version: String,
    pub transferred_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDiagnosticsStartup {
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<RuntimeDiagnosticsProgress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDiagnosticsSendQueue {
    pub queued_sends: u64,
    pub dropped_deltas: u64,
    pub dropped_important: u64,
    pub serialization_failures: u64,
    pub send_failures: u64,
    pub external_sink_failures: u64,
    pub max_queue_depth: usize,
    pub queue_depth_by_connection: HashMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDiagnosticsJournal {
    pub untrusted_thread_count: usize,
    pub failed_write_count: u64,
    pub dropped_event_count: u64,
    pub pending_thread_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDiagnosticsDbLocks {
    pub wait_count: u64,
    pub timeout_count: u64,
    pub sqlite_lock_error_count: u64,
    pub stale_recovery_count: u64,
    pub last_wait_ms: u64,
    pub max_wait_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDiagnosticsPayload {
    pub startup: RuntimeDiagnosticsStartup,
    pub send_queue: RuntimeDiagnosticsSendQueue,
    pub journal: RuntimeDiagnosticsJournal,
    pub db_locks: RuntimeDiagnosticsDbLocks,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDiagnosticsReadResult {
    pub diagnostics: RuntimeDiagnosticsPayload,
}

/// Deterministic schema & namespace manifest exported for `packages/harness` codegen.
pub fn export_protocol_schema_manifest() -> Value {
    let mut schemas = serde_json::Map::new();
    macro_rules! insert_schema {
        ($ty:ty) => {
            schemas.insert(
                stringify!($ty).to_owned(),
                serde_json::to_value(schema_for!($ty)).expect("serialize JsonSchema"),
            );
        };
    }

    insert_schema!(InitializeParams);
    insert_schema!(InitializeResult);
    insert_schema!(JsonRpcThread);
    insert_schema!(ThreadStartParams);
    insert_schema!(ThreadResumeParams);
    insert_schema!(ThreadListParams);
    insert_schema!(ThreadReadParams);
    insert_schema!(ThreadHydrateParams);
    insert_schema!(ThreadUnsubscribeParams);
    insert_schema!(ThreadPinnedSetParams);
    insert_schema!(ThreadArchivedSetParams);
    insert_schema!(TurnStartParams);
    insert_schema!(TurnSteerParams);
    insert_schema!(TurnInterruptParams);
    insert_schema!(SessionTitleSetParams);
    insert_schema!(SessionStateReadParams);
    insert_schema!(SessionModelSetParams);
    insert_schema!(SessionUsageBudgetSetParams);
    insert_schema!(SessionConfigSetParams);
    insert_schema!(SessionHarnessContextGetParams);
    insert_schema!(SessionHarnessContextSetParams);
    insert_schema!(SessionDefaultsApplyParams);
    insert_schema!(SessionFileUploadParams);
    insert_schema!(SessionDeleteParams);
    insert_schema!(WorkspaceListParams);
    insert_schema!(WorkspaceSwitchParams);
    insert_schema!(WorkspaceBootstrapParams);
    insert_schema!(CommandListParams);
    insert_schema!(CommandExecuteParams);
    insert_schema!(CreationPreflightParams);
    insert_schema!(CreationPreflightResult);
    insert_schema!(ProviderCatalogReadParams);
    insert_schema!(ProviderAuthMethodsReadParams);
    insert_schema!(ProviderStatusRefreshParams);
    insert_schema!(ProviderCodexAppServerStatusParams);
    insert_schema!(ProviderCodexAppServerUpdateParams);
    insert_schema!(ProviderLmStudioLocalStatusParams);
    insert_schema!(ProviderLmStudioLocalStartParams);
    insert_schema!(ProviderAuthAuthorizeParams);
    insert_schema!(ProviderAuthCallbackParams);
    insert_schema!(ProviderAuthLogoutParams);
    insert_schema!(ProviderAuthSetApiKeyParams);
    insert_schema!(ProviderAuthSetConfigParams);
    insert_schema!(ProviderAuthCopyApiKeyParams);
    insert_schema!(ProviderCustomModelAddParams);
    insert_schema!(ProviderCustomModelDeleteParams);
    insert_schema!(ProviderModelSetEnabledParams);
    insert_schema!(ProviderModelResetEnabledParams);
    insert_schema!(ConnectorsOpenAiNativeListParams);
    insert_schema!(ConnectorsOpenAiNativeRefreshParams);
    insert_schema!(ConnectorsOpenAiNativeSetEnabledParams);
    insert_schema!(RuntimeLibreOfficeCheckParams);
    insert_schema!(RuntimeLibreOfficeCheckResult);
    insert_schema!(RuntimeDiagnosticsReadParams);
    insert_schema!(RuntimeDiagnosticsReadResult);

    json!({
        "protocolVersion": JSONRPC_PROTOCOL_VERSION,
        "websocketProtocolVersion": WEBSOCKET_PROTOCOL_VERSION,
        "subprotocol": WEBSOCKET_SUBPROTOCOL,
        "namespaces": NAMESPACE_NAMES,
        "schemas": Value::Object(schemas),
    })
}
