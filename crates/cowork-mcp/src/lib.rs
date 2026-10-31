//! `cowork-mcp` — Native MCP Client Transports, 4-Layer Config Registry, RFC 9728/8414 OAuth 2.1 PKCE,
//! Tuple-Safe JSON Schema Normalizer & Generation-Refcounted `WorkspaceMcpToolCache`.

pub mod cache;
pub mod credentials;
pub mod oauth;
pub mod plugin_overrides;
pub mod registry;
pub mod schema;
pub mod transports;
pub mod types;

pub use cache::WorkspaceMcpToolCache;
pub use credentials::{
    McpCredentialsFile, auth_scope_for_source, compute_auth_state, credentials_path_for_scope,
    mask_secret, mutate_credentials_for_scope, read_credentials_file,
};
pub use oauth::{
    complete_mcp_oauth_callback, refresh_oauth_access_token, start_mcp_oauth_authorization,
};
pub use plugin_overrides::{
    DiscoveredPluginRoot, PluginEnableOverride, PluginOverridesFile, PluginScope,
    discover_installed_plugin_roots, mutate_plugin_overrides, plugin_mcp_override_key,
    plugin_overrides_path, plugin_skill_override_key, read_plugin_overrides,
};
pub use registry::{
    delete_mcp_server, layer_file_path, load_mcp_servers, read_mcp_servers_snapshot,
    resolve_target_mcp_server, set_mcp_server_api_key, set_mcp_server_enabled, upsert_mcp_server,
};
pub use schema::{
    DESCRIPTION_TRUNCATION_SUFFIX, MAX_MCP_DESCRIPTION_CHARS, build_mcp_tool_name,
    normalize_mcp_json_schema, normalize_mcp_name, truncate_mcp_description,
};
pub use transports::{load_mcp_tools, validate_mcp_server, validate_mcp_server_with_env};
pub use types::{
    HydratedMcpServer, LoadedMcpTool, McpAuthMode, McpAuthMutationResult, McpAuthScope,
    McpAuthStatus, McpConfigFileSummary, McpConfigLayer, McpConfigSource, McpOAuthChallengePayload,
    McpOAuthChallengeResult, McpOAuthRuntimeContext, McpServerAuthConfig, McpServerAuthState,
    McpServerCatalogEntry, McpServerConfig, McpServerTransport, McpServersSnapshot,
    McpToolErrorEntry, McpToolInvoker, McpTransportKind, McpValidatedToolSummary,
    McpValidationResult,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_config_layers_and_transports_match_contract() {
        assert!(McpConfigLayer::Plugin < McpConfigLayer::System);
        assert!(McpConfigLayer::System < McpConfigLayer::User);
        assert!(McpConfigLayer::User < McpConfigLayer::Workspace);
        assert_eq!(
            serde_json::to_string(&McpTransportKind::Http).unwrap(),
            "\"http\""
        );
    }
}
