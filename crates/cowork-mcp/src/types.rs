use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Supported MCP transport protocols on disk and over JSON-RPC (`"stdio" | "sse" | "http"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransportKind {
    Stdio,
    Sse,
    Http,
}

impl McpTransportKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::Sse => "sse",
            Self::Http => "http",
        }
    }
}

/// 4-layer MCP configuration source.
///
/// Effective precedence when merging duplicate server names:
/// `Workspace > User > System > Plugin (workspace-plugin > user-plugin)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpConfigSource {
    Plugin,
    System,
    User,
    Workspace,
}

impl McpConfigSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::User => "user",
            Self::System => "system",
            Self::Plugin => "plugin",
        }
    }
}

/// Backward-compatible alias for `McpConfigSource`.
pub type McpConfigLayer = McpConfigSource;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpAuthScope {
    Workspace,
    User,
}

impl McpAuthScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::User => "user",
        }
    }
}

/// Matches `mcpServerAuthModeSchema` in `src/shared/jsonrpcControlSchemas.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpAuthMode {
    None,
    Missing,
    ApiKey,
    Oauth,
    OauthPending,
    Error,
}

impl McpAuthMode {
    #[allow(non_upper_case_globals)]
    pub const OAuth: Self = Self::Oauth;
    #[allow(non_upper_case_globals)]
    pub const OAuthPending: Self = Self::OauthPending;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpAuthStatus {
    NotConfigured,
    Configured,
    NeedsAuthorization,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpServerTransport {
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<HashMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        headers: Option<HashMap<String, String>>,
    },
    Sse {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        headers: Option<HashMap<String, String>>,
    },
}

impl McpServerTransport {
    pub fn kind(&self) -> McpTransportKind {
        match self {
            Self::Stdio { .. } => McpTransportKind::Stdio,
            Self::Http { .. } => McpTransportKind::Http,
            Self::Sse { .. } => McpTransportKind::Sse,
        }
    }

    pub fn remote_url(&self) -> Option<&str> {
        match self {
            Self::Stdio { .. } => None,
            Self::Http { url, .. } | Self::Sse { url, .. } => Some(url.as_str()),
        }
    }

    pub fn with_merged_headers(&self, injected: HashMap<String, String>) -> Self {
        if injected.is_empty() {
            return self.clone();
        }
        match self {
            Self::Stdio { .. } => self.clone(),
            Self::Http { url, headers } => {
                let mut merged = headers.clone().unwrap_or_default();
                for (k, v) in injected {
                    let exists = merged.keys().any(|ek| ek.eq_ignore_ascii_case(&k));
                    if !exists {
                        merged.insert(k, v);
                    }
                }
                Self::Http {
                    url: url.clone(),
                    headers: Some(merged),
                }
            }
            Self::Sse { url, headers } => {
                let mut merged = headers.clone().unwrap_or_default();
                for (k, v) in injected {
                    let exists = merged.keys().any(|ek| ek.eq_ignore_ascii_case(&k));
                    if !exists {
                        merged.insert(k, v);
                    }
                }
                Self::Sse {
                    url: url.clone(),
                    headers: Some(merged),
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpServerAuthConfig {
    None,
    ApiKey {
        #[serde(
            default,
            rename = "headerName",
            skip_serializing_if = "Option::is_none"
        )]
        header_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix: Option<String>,
        #[serde(default, rename = "keyId", skip_serializing_if = "Option::is_none")]
        key_id: Option<String>,
    },
    #[serde(rename = "oauth")]
    OAuth {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resource: Option<String>,
        #[serde(default, rename = "oauthMode", skip_serializing_if = "Option::is_none")]
        oauth_mode: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    pub transport: McpServerTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retries: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<McpServerAuthConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerAuthState {
    pub mode: McpAuthMode,
    pub status: McpAuthStatus,
    pub message: String,
    pub has_stored_secret: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub masked_secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_client_id: Option<String>,
}

/// Strictly matches `mcpServersEventSchema.shape.files.element` (`.strict()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigFileSummary {
    pub source: McpConfigSource,
    pub path: String,
    pub exists: bool,
    pub editable: bool,
    pub legacy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<String>,
    pub server_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_scope: Option<String>,
}

/// Matches `mcpServersEventSchema.shape.servers.element` (`.passthrough()`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerCatalogEntry {
    #[serde(flatten)]
    pub config: McpServerConfig,
    pub source: McpConfigSource,
    pub inherited: bool,
    pub auth_mode: McpAuthMode,
    pub auth_scope: McpAuthScope,
    pub auth_message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_scope: Option<String>,
    pub auth_state: McpServerAuthState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServersSnapshot {
    pub servers: Vec<McpServerCatalogEntry>,
    pub files: Vec<McpConfigFileSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct McpOAuthRuntimeContext {
    pub server_name: String,
    pub remote_url: String,
    pub auth_scope: McpAuthScope,
    pub credentials_path: PathBuf,
    pub lock_root: PathBuf,
    pub configured_scope: Option<String>,
    pub configured_resource: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HydratedMcpServer {
    pub config: McpServerConfig,
    pub source: McpConfigSource,
    pub auth_scope: McpAuthScope,
    pub oauth_context: Option<McpOAuthRuntimeContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpValidatedToolSummary {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpValidationResult {
    pub name: String,
    pub ok: bool,
    pub mode: McpAuthMode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<McpValidatedToolSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthChallengePayload {
    pub method: String,
    pub instructions: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthChallengeResult {
    pub name: String,
    pub source: McpConfigSource,
    pub url: String,
    pub instructions: String,
    pub expires_at: u64,
    pub challenge: McpOAuthChallengePayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthMutationResult {
    pub name: String,
    pub source: McpConfigSource,
    pub mode: McpAuthMode,
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolErrorEntry {
    pub server: String,
    pub error: String,
}

#[async_trait::async_trait]
pub trait McpToolInvoker: Send + Sync {
    async fn call_tool(&self, raw_tool_name: &str, arguments: Value) -> Result<Value, String>;
    async fn close(&self);
}

#[derive(Clone)]
pub struct LoadedMcpTool {
    pub qualified_name: String,
    pub server_name: String,
    pub raw_tool_name: String,
    pub description: String,
    pub input_schema: Value,
    pub invoker: Arc<dyn McpToolInvoker>,
}

impl std::fmt::Debug for LoadedMcpTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadedMcpTool")
            .field("qualified_name", &self.qualified_name)
            .field("server_name", &self.server_name)
            .field("raw_tool_name", &self.raw_tool_name)
            .finish()
    }
}

impl LoadedMcpTool {
    pub async fn call(&self, arguments: Value) -> Result<Value, String> {
        self.invoker.call_tool(&self.raw_tool_name, arguments).await
    }
}
